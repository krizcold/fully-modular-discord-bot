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

/** @param {string} name */
function unquote(name) {
  return name.startsWith('"') ? String(JSON.parse(name)) : name;
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

// Nodes that hold statements: a range never takes one whole because one of
// its lines changed.
const CONTAINERS = new Set([
  ts.SyntaxKind.SourceFile, ts.SyntaxKind.Block, ts.SyntaxKind.ModuleBlock, ts.SyntaxKind.CaseBlock,
  ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.ClassExpression,
]);

/** @param {string} file */
function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * The line spans of the outermost nodes that hold no container: a whole
 * statement, or the condition or parameters of one that holds a block.
 * @param {string} file
 * @param {string} text
 * @returns {Range[]}
 */
export function blockFreeSpans(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  /** @param {number} pos */
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  /** @type {Range[]} */
  const spans = [];
  /**
   * @param {ts.Node} node
   * @returns {boolean}
   */
  const holdsContainer = node => {
    /** @type {ts.Node[]} */
    const children = [];
    ts.forEachChild(node, child => { children.push(child); });
    const held = children.map(holdsContainer);
    const holds = CONTAINERS.has(node.kind) || held.some(Boolean);
    if (holds) children.forEach((child, i) => { if (!held[i]) spans.push([lineOf(child.getStart(sf)), lineOf(child.getEnd())]); });
    return holds;
  };
  holdsContainer(sf);
  return spans;
}

/**
 * Each line widens to the block-free spans that cross it, so a mutant of a
 * whole multi-line condition or statement exists when one of its lines
 * changed, without the body that condition guards.
 * @param {Range[]} spans
 * @param {number[]} lines
 * @returns {Range[]}
 */
export function widen(spans, lines) {
  /** @type {Range[]} */
  const ranges = [];
  for (const line of lines) {
    ranges.push([line, line]);
    for (const span of spans) if (span[0] <= line && line <= span[1]) ranges.push([span[0], span[1]]);
  }
  return mergeRanges(ranges);
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
    targets.push({ file: entry.file, ranges: widen(blockFreeSpans(entry.file, text), lines), gating: [...new Set(entry.changed)].sort((a, b) => a - b) });
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
 * Whether a mutant (1-based lines, as Stryker reports them) touches a gating line.
 * @param {{ gating: number[] | null }} target
 * @param {Location} location
 */
export function gates(target, location) {
  return target.gating === null || target.gating.some(n => location.start.line <= n && n <= location.end.line);
}
