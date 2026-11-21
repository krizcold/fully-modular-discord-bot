// P1 part 0: gives every server id (and purchase user id) that an existing premium row uses, and that is not already
// a 17 to 19 digit id, a 17-digit Discord id. Run from test/: `node p1Renumber.cjs --plan` prints each file's table and
// its count per token class, `--apply` edits and asserts those counts, and a second `--apply` reports zero.
// `--lines` adds every line a plan would change; `--only <path part>` keeps the files whose path holds the text;
// `--resume` finishes an apply that stopped part way (it skips the check that a new id is unused in its file).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIRS = ['unit', 'integration', 'helpers', 'oracle', 'child'];
const SERVER_METHODS = [
  'grantManual', 'extendManual', 'revokeManual', 'initiatePaidSubscription', 'cancelPaidSubscription',
  'reactivatePaidSubscription', 'cancelPaidSubscriptionImmediately', 'cancelAndRemovePausedSubscription',
  'findOrphansForGuild', 'adoptOrphan', 'getSubscriptions', 'getGuildSubscriptions', 'setNotificationsChannelId',
  'unlinkProviderAccount', 'getGuildSubscriptionUrl', 'resolveActiveTier', 'getTierOverrides', 'getTierHardLimits',
  'getPaidTierDelta', 'hasFeatureAccess', 'hasFeature', 'getPendingMigrationsForGuild', 'listSubscriptionsForGuild',
];
// Methods whose server id is not the first argument: the argument's index.
const SERVER_ARG = { linkAccount: 2, getAccountLink: -1, recordMigrationDecision: 1 };
const FILE_METHODS = [...SERVER_METHODS, ...Object.keys(SERVER_ARG), 'initiatePurchase', 'dispatchPremiumNotification'];
const OP_METHODS = new Set([...SERVER_METHODS, ...Object.keys(SERVER_ARG)]);

// Ids of the form g<N> become 7 and N padded to 16 digits, so a helper and the rows that use it agree and a computed
// `g${i}` has a computed twin. Every other id has its own line here; an id found with no line stops the run.
const OTHER_SERVERS = require('./p1Renumber.ids.json').servers;
const USERS = require('./p1Renumber.ids.json').users;
// Texts the detection meets in an id's place that are no server id (a Dummy state's map is keyed by its own ids).
const NOT_IDS = new Set(require('./p1Renumber.ids.json').notIds);
// Ids a file keeps, with the reason, by path.
const KEEP = require('./p1Renumber.ids.json').keep;
// Computed ids: a template or a literal whose whole text is `from` becomes `to`, `count` times in the file (a
// template that builds a server id, or the literal twin of an id a fake builds from one).
const COMPUTED = require('./p1Renumber.ids.json').computed;
// Lines of a file on which an id of its table is something else (a provider id spelled like a server's) and stays.
const KEEP_AT = require('./p1Renumber.ids.json').keepAt;
// Files the three criteria name whose ids never reach premium.
const SKIP_FILES = new Set(require('./p1Renumber.ids.json').skipFiles);
// Files the criteria miss that expect another file's ids (a log line of a child scenario, a route's query).
const ALSO_FILES = new Set(require('./p1Renumber.ids.json').alsoFiles);

// After an apply that stopped part way, a file may hold a new id beside the old one it replaces.
const RESUME = process.argv.includes('--resume');
const DONE = /^\d{17,19}$/;
const WORD = /[A-Za-z0-9_]/;
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '&&', '||', '??', '===', '!==', '==', '!=']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'new', 'else', 'do']);

function lex(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  const braces = [];
  let depth = 0;
  const last = () => tokens[tokens.length - 1];
  const quasi = from => {
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return { end: j, sub: false };
      if (c === '$' && text[j + 1] === '{') return { end: j, sub: true };
      j += 1;
    }
    return { end: n, sub: false };
  };
  const pushQuasi = (start, afterSub) => {
    const q = quasi(start);
    tokens.push({ type: 'quasi', start, end: q.end, value: text.slice(start, q.end), leftSub: afterSub, rightSub: q.sub });
    if (q.sub) {
      braces.push(depth);
      depth += 1;
      tokens.push({ type: 'punct', start: q.end, end: q.end + 2, value: '${' });
      i = q.end + 2;
    } else {
      i = q.end + 1;
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      tokens.push({ type: 'comment', start: i, end: j, value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      tokens.push({ type: 'comment', start: i, end: j, value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '\n') break;
        if (text[j] === c) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        tokens.push({ type: 'str', start: i + 1, end: j, value: text.slice(i + 1, j) });
        i = j + 1;
      } else {
        tokens.push({ type: 'punct', start: i, end: i + 1, value: c });
        i += 1;
      }
      continue;
    }
    if (c === '`') { pushQuasi(i + 1, false); continue; }
    if (c === '{') { depth += 1; tokens.push({ type: 'punct', start: i, end: i + 1, value: c }); i += 1; continue; }
    if (c === '}') {
      depth -= 1;
      if (braces.length && braces[braces.length - 1] === depth) {
        braces.pop();
        tokens.push({ type: 'punct', start: i, end: i + 1, value: '}$' });
        pushQuasi(i + 1, true);
        continue;
      }
      tokens.push({ type: 'punct', start: i, end: i + 1, value: c });
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
      tokens.push({ type: 'word', start: i, end: j, value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.]/.test(text[j])) j += 1;
      tokens.push({ type: 'num', start: i, end: j, value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '/') {
      let prev = last();
      for (let k = tokens.length - 1; k >= 0 && prev && prev.type === 'comment'; k--) prev = tokens[k - 1];
      const opens = !prev || (prev.type === 'punct' && REGEX_AFTER.has(prev.value)) || (prev.type === 'word' && REGEX_AFTER_WORD.has(prev.value));
      if (opens) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n && text[j] !== '\n') {
          if (text[j] === '\\') { j += 2; continue; }
          if (text[j] === '[') inClass = true;
          else if (text[j] === ']') inClass = false;
          else if (text[j] === '/' && !inClass) { closed = true; break; }
          j += 1;
        }
        if (closed) {
          j += 1;
          while (j < n && /[a-z]/.test(text[j])) j += 1;
          tokens.push({ type: 'regex', start: i, end: j, value: text.slice(i, j) });
          i = j;
          continue;
        }
      }
    }
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    const op = ['===', '!=='].includes(three) ? three : ['==', '!=', '=>', '?.', '&&', '||', '??'].includes(two) ? two : c;
    tokens.push({ type: 'punct', start: i, end: i + op.length, value: op });
    i += op.length;
  }
  return tokens;
}

const isLiteral = t => !!t && (t.type === 'str' || (t.type === 'quasi' && !t.leftSub && !t.rightSub));
const isPunct = (t, value) => !!t && t.type === 'punct' && t.value === value;

function fileList() {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(e.name) && !/^p1[A-Z]/.test(e.name)) out.push(p);
    }
  };
  for (const d of DIRS) walk(path.join(ROOT, d));
  const methods = new RegExp('\\b(' + FILE_METHODS.join('|') + ')\\b');
  return out.filter(file => {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (SKIP_FILES.has(rel)) return false;
    if (ALSO_FILES.has(rel)) return true;
    const t = fs.readFileSync(file, 'utf8');
    if (!/premium|payment|Provider|subscription/i.test(t)) return false;
    return methods.test(t)
      || (/guildId/.test(t) && /providerSubId|subscription\.(created|renewed|updated|cancelled|expired|resumed|paused)/.test(t))
      || /subscriptions(\[|\.\w|\?\.|: \{)/.test(t);
  }).sort();
}

/** The ids this file hands premium, by kind, and the computed templates met in an id's place. */
function detect(tokens) {
  const sig = tokens.filter(t => t.type !== 'comment');
  const consts = new Map();
  for (let k = 0; k + 3 < sig.length; k++) {
    if (sig[k].type === 'word' && sig[k].value === 'const' && sig[k + 1].type === 'word' && isPunct(sig[k + 2], '=') && isLiteral(sig[k + 3])
      && (isPunct(sig[k + 4], ';') || isPunct(sig[k + 4], ',') || (sig[k + 4] && sig[k + 4].type === 'word'))) {
      consts.set(sig[k + 1].value, sig[k + 3].value);
    }
  }
  const servers = new Set();
  const users = new Set();
  const computed = new Set();
  const take = (t, into) => {
    if (!t) return;
    if (isLiteral(t)) into.add(t.value);
    else if (t.type === 'quasi') computed.add(t.value + '${');
    else if (t.type === 'word' && consts.has(t.value)) into.add(consts.get(t.value));
  };
  // The token that starts argument `index` of the call whose `(` is at `open`.
  const argAt = (open, index) => {
    let nest = 0;
    let at = 0;
    for (let k = open + 1; k < sig.length; k++) {
      const t = sig[k];
      if (nest === 0 && at === index) return t;
      if (t.type === 'punct') {
        if ('([{'.includes(t.value) || t.value === '${') nest += 1;
        else if (')]}'.includes(t.value) || t.value === '}$') { if (nest === 0) return null; nest -= 1; }
        else if (t.value === ',' && nest === 0) at += 1;
      }
    }
    return null;
  };
  // The keys of the object literal whose `{` is at `open`; with `values`, the literal values one level further down.
  const keysOf = (open, values) => {
    let nest = 0;
    for (let j = open + 1; j < sig.length; j++) {
      const u = sig[j];
      if (u.type === 'punct' && ('([{'.includes(u.value) || u.value === '${')) {
        if (nest === 0 && u.value === '[' && (isPunct(sig[j - 1], '{') || isPunct(sig[j - 1], ','))) take(sig[j + 1], servers);
        nest += 1;
      } else if (u.type === 'punct' && (')]}'.includes(u.value) || u.value === '}$')) {
        if (nest === 0) return;
        nest -= 1;
      } else if (!values && nest === 0 && isPunct(sig[j + 1], ':') && (isPunct(sig[j - 1], '{') || isPunct(sig[j - 1], ','))) {
        if (u.type === 'word' || u.type === 'num' || isLiteral(u)) servers.add(u.value);
      } else if (values && nest === 1 && isPunct(sig[j - 1], ':') && (isPunct(sig[j + 1], ',') || isPunct(sig[j + 1], '}'))) {
        take(u, servers);
      }
    }
  };
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    const next = sig[k + 1];
    const named = (t.type === 'word' || t.type === 'str') ? t.value : null;
    // In a file of the list a text of the form g<N> is a server id wherever it stands.
    const keyOrMember = t.type === 'word' && (isPunct(sig[k - 1], '.') || isPunct(sig[k - 1], '?.') || (isPunct(next, ':') && (isPunct(sig[k - 1], '{') || isPunct(sig[k - 1], ','))));
    if (isLiteral(t) || keyOrMember) {
      if (/^g\d{1,4}$/.test(t.value)) servers.add(t.value);
    }
    if (t.type === 'str' || t.type === 'quasi' || t.type === 'regex') {
      for (const m of t.value.matchAll(/(?<![A-Za-z0-9_])g\d{1,4}(?![A-Za-z0-9_])/g)) {
        const edge = (m.index === 0 && t.leftSub) || (m.index + m[0].length === t.value.length && t.rightSub);
        if (!edge) servers.add(m[0]);
      }
    }
    if (named === 'guild' && next && next.type === 'punct' && [':', '='].includes(next.value)) take(sig[k + 2], servers);
    if (t.type === 'word' && t.value === 'writePremium' && isPunct(next, '(') && isPunct(sig[k + 2], '{')) keysOf(k + 2, false);
    if (named === 'providerAccountLinks' && isPunct(next, ':') && isPunct(sig[k + 2], '{')) keysOf(k + 2, true);
    if (named === 'guildId' || named === 'userId') {
      const into = named === 'guildId' ? servers : users;
      if (next && next.type === 'punct' && [':', '=', '===', '!==', '==', '!='].includes(next.value)) take(sig[k + 2], into);
    }
    if (t.type === 'word' && isPunct(next, '(')) {
      if (SERVER_METHODS.includes(t.value)) take(argAt(k + 1, 0), servers);
      else if (Object.hasOwn(SERVER_ARG, t.value) && SERVER_ARG[t.value] >= 0) take(argAt(k + 1, SERVER_ARG[t.value]), servers);
    }
    if (t.type === 'str' && /^premium\./.test(t.value) && OP_METHODS.has(t.value.slice(8))) {
      const index = SERVER_ARG[t.value.slice(8)] ?? 0;
      let j = k + 1;
      while (sig[j] && (isPunct(sig[j], ',') || isPunct(sig[j], ':') || isPunct(sig[j], '{') || (sig[j].type === 'word' && sig[j].value === 'args'))) j += 1;
      if (isPunct(sig[j], '[')) take(argAt(j, index), servers);
    }
    if (t.type === 'word' && t.value === 'subscriptions') {
      if ((isPunct(next, '.') || isPunct(next, '?.')) && sig[k + 2] && sig[k + 2].type === 'word' && /^(g\d*|R|G\d*)$/.test(sig[k + 2].value) && !consts.has(sig[k + 2].value)) servers.add(sig[k + 2].value);
      if (isPunct(next, '[')) take(sig[k + 2], servers);
      if (isPunct(next, '?.') && isPunct(sig[k + 2], '[')) take(sig[k + 3], servers);
      if (isPunct(next, ':') && isPunct(sig[k + 2], '{')) keysOf(k + 2, false);
    }
  }
  return { servers, users, computed };
}

function newIdOf(id, kind) {
  if (kind === 'user') return USERS[id];
  const m = /^g(\d{1,4})$/.exec(id);
  if (m) return '7' + m[1].padStart(16, '0');
  return OTHER_SERVERS[id];
}

function plan(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const tokens = lex(text);
  const found = detect(tokens);
  const kept = KEEP[rel] || {};
  const table = new Map();
  const missing = [];
  const add = (ids, kind) => {
    for (const id of ids) {
      if (id === '' || DONE.test(id) || NOT_IDS.has(id) || Object.hasOwn(kept, id) || table.has(id)) continue;
      const to = newIdOf(id, kind);
      if (!to) { missing.push(`${kind} '${id}'`); continue; }
      if (text.includes(to) && !RESUME) throw new Error(`${rel}: ${to} is already in the file, so '${id}' cannot take it`);
      table.set(id, to);
    }
  };
  add(found.servers, 'server');
  add(found.users, 'user');
  const computedRules = COMPUTED.filter(r => r.file === rel);
  const edits = [];
  const sig = tokens.filter(t => t.type !== 'comment');
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (t.type === 'quasi' && !t.leftSub && t.rightSub) {
      let end = k;
      while (sig[end] && !(sig[end].type === 'quasi' && !sig[end].rightSub && end > k)) end += 1;
      const whole = sig[end] ? text.slice(t.start, sig[end].end) : null;
      const rule = whole === null ? undefined : computedRules.find(r => r.from === whole);
      if (rule) {
        edits.push({ start: t.start, end: sig[end].end, text: rule.to, cls: 'd' });
        k = end;
        continue;
      }
    }
    const derived = isLiteral(t) ? computedRules.find(r => r.from === t.value) : undefined;
    if (derived) { edits.push({ start: t.start, end: t.end, text: derived.to, cls: 'd' }); continue; }
    if (table.size === 0) continue;
    if (isLiteral(t) && table.has(t.value)) { edits.push({ start: t.start, end: t.end, text: table.get(t.value), cls: 'a' }); continue; }
    if ((t.type === 'word' || t.type === 'num') && table.has(t.value)) {
      const prev = sig[k - 1];
      const next = sig[k + 1];
      if (isPunct(prev, '.') || isPunct(prev, '?.')) {
        if (prev.value === '.') edits.push({ start: prev.start, end: t.end, text: `['${table.get(t.value)}']`, cls: 'b' });
        else edits.push({ start: t.start, end: t.end, text: `['${table.get(t.value)}']`, cls: 'b' });
      } else if (isPunct(next, ':') && (isPunct(prev, '{') || isPunct(prev, ','))) {
        edits.push({ start: t.start, end: t.end, text: `'${table.get(t.value)}'`, cls: 'b' });
      }
      continue;
    }
    if (t.type === 'str' || t.type === 'quasi' || t.type === 'regex') {
      for (const [id, to] of table) {
        let from = 0;
        for (;;) {
          const at = t.value.indexOf(id, from);
          if (at < 0) break;
          from = at + id.length;
          const before = at === 0 ? (t.leftSub ? 'x' : '') : t.value[at - 1];
          const after = from === t.value.length ? (t.rightSub ? 'x' : '') : t.value[from];
          if (WORD.test(before) || WORD.test(after)) continue;
          edits.push({ start: t.start + at, end: t.start + from, text: to, cls: t.type === 'regex' ? 'r' : 'c' });
        }
      }
    }
  }
  const keepAt = (KEEP_AT[rel] || {});
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineAt = offset => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line += 1;
    return line + 1;
  };
  for (const [id, lines] of Object.entries(keepAt)) {
    if (!table.has(id)) continue;
    const to = table.get(id);
    for (const line of lines) {
      const at = edits.filter(e => e.cls !== 'd' && e.text.includes(to) && lineAt(e.start) === line);
      if (at.length === 0) throw new Error(`${rel}: line ${line} is listed to keep '${id}' and holds none`);
      for (const e of at) edits.splice(edits.indexOf(e), 1);
    }
  }
  edits.sort((a, b) => a.start - b.start);
  for (let k = 1; k < edits.length; k++) {
    if (edits[k].start < edits[k - 1].end) throw new Error(`${rel}: two edits overlap at offset ${edits[k].start}`);
  }
  for (const rule of computedRules) {
    const made = edits.filter(e => e.cls === 'd' && e.text === rule.to).length;
    const after = text.split(rule.to).length - 1;
    if (made !== rule.count && !(made === 0 && after === rule.count)) throw new Error(`${rel}: computed rule ${rule.from} matched ${made}, expected ${rule.count}`);
  }
  const counts = { a: 0, b: 0, c: 0, r: 0, d: 0 };
  for (const e of edits) counts[e.cls] += 1;
  const unruled = [...found.computed].filter(c => !computedRules.some(r => r.from.startsWith(c) || r.to.startsWith(c)) && !(kept[c]));
  return { rel, text, table, edits, counts, missing, unruled, kept };
}

function applyEdits(text, edits) {
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

function changedLines(text, edits) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineOf = offset => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const after = applyEdits(text, edits).split('\n');
  const lines = new Map();
  for (const e of edits) {
    const line = lineOf(e.start);
    lines.set(line, { now: after[line], cls: ((lines.get(line) || {}).cls || '') + e.cls });
  }
  return [...lines].sort((a, b) => a[0] - b[0]).map(([line, l]) => ({ line: line + 1, now: l.now.replace(/\r$/, ''), cls: l.cls }));
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--apply') ? 'apply' : args.includes('--plan') ? 'plan' : null;
  if (!mode) {
    console.error('Usage: node p1Renumber.cjs --plan [--lines] | --apply   [--only <path part>]');
    process.exit(2);
  }
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const files = fileList().filter(f => !only || f.replace(/\\/g, '/').includes(only));
  const plans = files.map(plan);
  const missing = plans.flatMap(p => p.missing.map(m => `${p.rel}: ${m}`));
  const unruled = plans.flatMap(p => p.unruled.map(m => `${p.rel}: \`${m}...}\``));
  const total = { a: 0, b: 0, c: 0, r: 0, d: 0 };
  let touched = 0;
  for (const p of plans) {
    const n = p.edits.length;
    const keptNames = Object.keys(p.kept);
    if (n === 0 && args.includes('--untouched')) console.log(`${p.rel}: nothing to change`);
    if (n === 0 && keptNames.length === 0) continue;
    if (n > 0) touched += 1;
    for (const cls of 'abcrd') total[cls] += p.counts[cls];
    const table = [...p.table].filter(([, to]) => p.edits.some(e => e.text.includes(to))).map(([id, to]) => `${id} -> ${to}`).join(', ');
    console.log(`${p.rel}: a=${p.counts.a} b=${p.counts.b} c=${p.counts.c} r=${p.counts.r} d=${p.counts.d}  [${table}]${keptNames.length ? `  kept: ${keptNames.join(', ')}` : ''}`);
    if (args.includes('--lines')) for (const l of changedLines(p.text, p.edits)) console.log(`    ${l.line} [${l.cls}]: ${l.now.trim()}`);
  }
  console.log(`${mode === 'apply' ? 'Applying' : 'Plan'}: ${files.length} file(s) read, ${touched} to change; a=${total.a} b=${total.b} c=${total.c} r=${total.r} d=${total.d}`);
  if (unruled.length) console.log(`Computed ids with no rule (${unruled.length}):\n  ${unruled.join('\n  ')}`);
  if (missing.length) {
    console.error(`Ids with no new id in p1Renumber.ids.json (${missing.length}):\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  if (mode === 'plan') return;
  const expectLines = [];
  for (const p of plans) {
    if (p.edits.length === 0) continue;
    const next = applyEdits(p.text, p.edits);
    const file = path.join(ROOT, p.rel);
    fs.writeFileSync(file, next);
    const again = plan(file);
    const left = again.edits.filter(e => !Object.keys(KEEP_AT[p.rel] || {}).some(id => e.text.includes(newIdOf(id, 'server'))));
    if (left.length !== 0) throw new Error(`${p.rel}: ${left.length} edit(s) still planned after the apply`);
    const made = { a: 0, b: 0, c: 0, r: 0, d: 0 };
    for (const e of p.edits) made[e.cls] += 1;
    const gained = [...new Set(p.edits.filter(e => e.cls !== 'd').map(e => e.text.replace(/[^0-9]/g, '')))]
      .reduce((sum, to) => sum + (next.split(to).length - 1) - (p.text.split(to).length - 1), 0);
    const newIds = [...new Set(p.edits.filter(e => e.cls !== 'd').map(e => e.text.replace(/[^0-9]/g, '')))];
    const inComputed = p.edits.filter(e => e.cls === 'd').reduce((sum, e) => sum + newIds.reduce((n, to) => n + e.text.split(to).length - 1, 0), 0);
    const planned = p.counts.a + p.counts.b + p.counts.c + p.counts.r + inComputed;
    if (gained !== planned || 'abcrd'.split('').some(cls => made[cls] !== p.counts[cls])) {
      throw new Error(`${p.rel}: planned ${planned} id(s), the file gained ${gained}`);
    }
    for (const l of changedLines(p.text, p.edits)) if (/\bexpect\b/.test(l.now)) expectLines.push(`${p.rel}:${l.line}: ${l.now.trim()}`);
  }
  console.log(`Applied: ${touched} file(s) changed; a=${total.a} b=${total.b} c=${total.c} r=${total.r} d=${total.d}`);
  console.log(`Changed lines that hold expect (${expectLines.length}):`);
  for (const l of expectLines) console.log(l);
}

main();
