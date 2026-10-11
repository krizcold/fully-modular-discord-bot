// Which lines of src a change touched, and the Stryker mutate ranges that
// cover them (VERIFY.md L5). Pure: the caller runs git and reads the files.
import ts from 'typescript';

/**
 * @typedef {[number, number]} Range first and last line, 1-based
 * @typedef {{ file: string, changed: number[], deletedAfter: number[] }} FileChange
 * @typedef {{ file: string, ranges: Range[] | null, gating: number[] | null }} Target ranges null: the whole file
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

/**
 * Reads `git diff -U0` output: per file, the new-side lines added or changed,
 * and the new-side lines after which lines were only deleted. File headers are
 * read only between a `diff --git` line and the first hunk, so a content line
 * that happens to start with "+++" is never taken for one.
 * @param {string} text
 * @returns {FileChange[]}
 */
export function parseDiff(text) {
  /** @type {Map<string, FileChange>} */
  const files = new Map();
  /** @type {FileChange | null} */
  let current = null;
  let header = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true;
      current = null;
    } else if (header && line.startsWith('+++ ')) {
      const name = unquote(line.slice(4));
      current = name === '/dev/null' ? null : { file: name.replace(/^b\//, ''), changed: [], deletedAfter: [] };
      if (current) files.set(current.file, current);
    } else if (line.startsWith('@@')) {
      header = false;
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk || !current) continue;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) current.deletedAfter.push(start);
      for (let n = start; n < start + count; n++) current.changed.push(n);
    }
  }
  return [...files.values()];
}

// git quotes a name holding special characters, and ends a name holding a
// space with a tab (for patch's sake).
/** @param {string} name */
function unquote(name) {
  return name.startsWith('"') ? String(JSON.parse(name)) : name.replace(/\t$/, '');
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

/** @param {string} file */
function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * The spans one line widens to: the statement it sits in, or the part of a
 * compound statement it sits in (a condition, a signature), taken whole even
 * when a block-bodied callback sits inside it, so every mutant of a changed
 * operator, condition or call exists. A body is never taken because its
 * header line changed: a line wholly inside a body widens within that body.
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
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  /** @type {Range[]} */
  const ranges = [];
  for (const line of lines) ranges.push([line, line], ...unitsOf(sf, line));
  return mergeRanges(ranges);
}

// Tokens no mutant is made of: brackets, separators, and the keywords that only join blocks.
const STRUCTURE = new Set([
  ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.ElseKeyword, ts.SyntaxKind.TryKeyword, ts.SyntaxKind.FinallyKeyword, ts.SyntaxKind.DoKeyword,
  ts.SyntaxKind.EndOfFileToken,
]);

/**
 * The lines that hold code: a token other than a bracket, a separator or a
 * block-joining keyword starts on them or runs across them (a multi-line
 * template). Blank, comment-only and brace-only lines are left out, wherever
 * they sit, since no mutant could touch them.
 * @param {string} file
 * @param {string} text
 * @param {number[]} lines
 */
export function codeLines(file, text, lines) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
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

/**
 * git arguments for the diff of src from base to the working tree, with every
 * option a user's config could change set here: the path prefixes, rename and
 * copy detection, hunk joining, relative paths, colour, external diff tools.
 * @param {string} base
 */
export function diffArgs(base) {
  return [
    '-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.renames=true',
    'diff', '-U0', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--no-color',
    '--no-ext-diff', '--no-textconv', '--diff-filter=ACMR', base, '--', 'src',
  ];
}

/**
 * The mutate targets for a change. `gating` lists the changed lines: a mutant
 * that touches one of them must be killed; the others in the widened ranges
 * are context, run and listed but never gating. A pure deletion widens its two
 * neighbouring lines as context. An untracked file is taken whole (gating null:
 * every mutant gates).
 * @param {{ diff: FileChange[], untracked: string[], read: (file: string) => string }} change
 * @returns {{ targets: Target[], skipped: { file: string, why: string }[] }}
 */
export function planTargets({ diff, untracked, read }) {
  /** @type {Target[]} */
  const targets = [];
  /** @type {{ file: string, why: string }[]} */
  const skipped = [];
  for (const entry of diff) {
    const why = notMutated(entry.file);
    if (why) { skipped.push({ file: entry.file, why }); continue; }
    const text = read(entry.file);
    const lineCount = text.split('\n').length;
    const neighbours = entry.deletedAfter.flatMap(n => [n, n + 1]).filter(n => n >= 1 && n <= lineCount);
    const lines = [...new Set([...entry.changed, ...neighbours])];
    if (lines.length === 0) { skipped.push({ file: entry.file, why: 'no changed lines (a rename or a mode change)' }); continue; }
    targets.push({ file: entry.file, ranges: widen(entry.file, text, lines), gating: [...new Set(entry.changed)].sort((a, b) => a - b) });
  }
  for (const file of untracked) {
    const why = notMutated(file);
    if (why) skipped.push({ file, why });
    else targets.push({ file, ranges: null, gating: null });
  }
  return { targets, skipped };
}

/**
 * @param {Target} target
 * @returns {string[]}
 */
export function patternsOf(target) {
  return target.ranges ? target.ranges.map(([start, end]) => `${target.file}:${start}-${end}`) : [target.file];
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
    const range = /:(\d+)(?::\d+)?-(\d+)(?::\d+)?$/.exec(pattern);
    const [from, to] = range ? [Number(range[1]), Math.min(Number(range[2]), lineCount)] : [1, lineCount];
    for (let n = from; n <= to; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Whether a mutant (1-based lines, as Stryker reports them) touches a gating line.
 * @param {{ gating: number[] | null }} target
 * @param {Location} location
 */
export function gates(target, location) {
  return target.gating === null || target.gating.some(n => location.start.line <= n && n <= location.end.line);
}
