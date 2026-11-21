// P1 part 3 (sheet P1, decision 20): re-keys the existing premium rows from server ids to holder keys, by token class.
// Run from test/: `node p1Rekey.cjs manager --plan` prints, per file, the count per class, every changed line that
// holds `expect`, and the places it leaves for a hand edit; `--apply` edits and asserts the same counts; a second
// `--apply` reports zero. `--only <path part>` keeps the files whose path holds the text.
//
// The manager mode's classes. A literal id becomes the literal key ('guild:<id>'); any other expression is wrapped in
// gh(...) from helpers/p1Holder.ts, whose import the script adds.
//   m  the holder argument of a manager method call (grantManual(<holder>, ...), linkAccount(.., .., <holder>))
//   o  the holder argument of a premium.<method> op's args array
//   k  a store key read: subscriptions[<key>]
//   s  a seeded key: a key of an object literal that is the value of `subscriptions`, writePremium's first argument,
//      or any key whose value is an object literal starting with `active`, `paused` or `notificationsChannelId`
//   b  a purchase's `userId` option renamed to `buyerId`
//   r  a renamed method: findOrphansForGuild, getGuildSubscriptions, getPendingMigrationsForGuild
// It edits nothing else. Seeded links and decisions, audit fields, expected texts and private methods are hand edits.
//
// P1 part 4a: `node p1Rekey.cjs event --plan|--apply` moves the rows that build a provider event or a purchase to the
// new members. Its classes:
//   e  the `guildId` property of an object literal whose `type` is a subscription event: renamed to `holder`, its
//      value turned into a holder key as above (a shorthand `guildId` becomes `holder: gh(guildId)`)
//   c  a created event literal with no `buyerId`: `buyerId: '80000000000000001'` added after its `type`
//   p  the options of an initiatePaidSubscription call or op (its fourth argument, an object literal) with no
//      `buyerId`: the same buyer added as its first property
// Seeded paid subscriptions, listed records and fake providers' list members are hand edits.
const fs = require('fs');
const path = require('path');
const { lex, isLiteral, isPunct } = require('./p1Lex.cjs');

const ROOT = __dirname;
const DIRS = ['unit', 'integration', 'helpers', 'oracle'];
const ID = /^[1-9][0-9]{16,19}$/;
// The holder argument's index, per method that takes a holder.
const HOLDER_ARG = Object.assign(Object.create(null), {
  grantManual: 0, extendManual: 0, revokeManual: 0, initiatePaidSubscription: 0, cancelPaidSubscription: 0,
  reactivatePaidSubscription: 0, cancelPaidSubscriptionImmediately: 0, cancelAndRemovePausedSubscription: 0,
  findOrphansForGuild: 0, findOrphansFor: 0, adoptOrphan: 0, getSubscriptions: 0, getGuildSubscriptions: 0,
  getHolderSubscriptions: 0, setNotificationsChannelId: 0, unlinkProviderAccount: 0, getPendingMigrationsForGuild: 0,
  getPendingMigrationsFor: 0, linkAccount: 2, recordMigrationDecision: 1,
});
// Without a prototype: `toString` is a method name the rows call, and no key of these maps.
const RENAMED = Object.assign(Object.create(null), { findOrphansForGuild: 'findOrphansFor', getGuildSubscriptions: 'getHolderSubscriptions', getPendingMigrationsForGuild: 'getPendingMigrationsFor' });
// Expressions the classes meet in a holder's place that are no server id: the Dummy's own state is keyed by its
// subscription ids, and one row hands its op helper a function.
const NOT_HOLDERS = Object.assign(Object.create(null), {
  'helpers/nb6DummyRig.ts': ['id'],
  'unit/rm7DummyProvider.test.ts': ['r.providerSubId as string', 'id'],
  'unit/nb6FixR1D.test.ts': ['bought.providerSubId'],
  'unit/nb10ProviderTimeout.test.ts': ['async'],
});
const RECORD_KEYS = new Set(['active', 'paused', 'notificationsChannelId']);
const OPENERS = new Set(['(', '[', '{', '${']);
const CLOSERS = new Set([')', ']', '}', '}$']);

function fileList(only) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/^p1[A-Z]/.test(e.name)) out.push(p);
    }
  };
  for (const d of DIRS) walk(path.join(ROOT, d));
  const trigger = new RegExp('\\b(' + Object.keys(HOLDER_ARG).join('|') + '|writePremium)\\b|subscriptions(\\[|\\?\\.\\[|: \\{)');
  return out
    .filter(file => /premium|payment|Provider|subscription/i.test(fs.readFileSync(file, 'utf8')) && trigger.test(fs.readFileSync(file, 'utf8')))
    .filter(file => !only || file.replace(/\\/g, '/').includes(only))
    .sort();
}

function planManager(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const sig = lex(text).filter(t => t.type !== 'comment');
  const edits = [];
  const hand = [];
  const lineOf = offset => text.slice(0, offset).split('\n').length;
  let needsImport = false;

  // The token span [from, to) of the argument `index` of the list opened at `open`; null when it has none.
  const argSpan = (open, index) => {
    let nest = 0;
    let at = 0;
    let from = open + 1;
    for (let k = open + 1; k < sig.length; k++) {
      const t = sig[k];
      if (t.type === 'punct') {
        if (OPENERS.has(t.value)) { nest += 1; continue; }
        if (CLOSERS.has(t.value)) {
          if (nest === 0) return at === index && k > from ? [from, k] : null;
          nest -= 1;
          continue;
        }
        if (t.value === ',' && nest === 0) {
          if (at === index) return [from, k];
          at += 1;
          from = k + 1;
        }
      }
    }
    return null;
  };
  // Turns the expression in the span into a holder key; `cls` is the class counted.
  const rekey = (span, cls) => {
    if (!span) return;
    const [from, to] = span;
    const first = sig[from];
    const last = sig[to - 1];
    if (to - from === 1 && isLiteral(first)) {
      if (/^(guild|user):/.test(first.value)) return;
      if (ID.test(first.value)) edits.push({ cls, start: first.start, end: first.start, text: 'guild:' });
      else hand.push(`${rel}:${lineOf(first.start)} ${cls}: the literal '${first.value}' is no Discord id`);
      return;
    }
    if (first.type === 'word' && (first.value === 'gh' || first.value === 'uh') && isPunct(sig[from + 1], '(')) return;
    if (first.type === 'word' && /holder/i.test(first.value) && to - from === 1) return;
    const skip = NOT_HOLDERS[rel] || [];
    if (skip.includes(text.slice(first.start, last.end)) || (first.type === 'word' && first.value === 'async' && skip.includes('async'))) return;
    if (first.type === 'punct' && first.value === '...') { hand.push(`${rel}:${lineOf(first.start)} ${cls}: a spread argument`); return; }
    const quote = t => (t.type === 'str' || t.type === 'quasi' ? 1 : 0);
    edits.push({ cls, start: first.start - quote(first), end: first.start - quote(first), text: 'gh(' });
    edits.push({ cls: null, start: last.end + quote(last), end: last.end + quote(last), text: ')' });
    needsImport = true;
  };
  // The keys of the object literal opened at `open`, re-keyed as seeds.
  const seedKeys = open => {
    let nest = 0;
    for (let j = open + 1; j < sig.length; j++) {
      const u = sig[j];
      const atKey = nest === 0 && (isPunct(sig[j - 1], '{') || isPunct(sig[j - 1], ','));
      if (u.type === 'punct' && OPENERS.has(u.value)) {
        if (atKey && u.value === '[') {
          let close = j + 1;
          let inner = 0;
          while (sig[close] && !(inner === 0 && isPunct(sig[close], ']'))) {
            if (sig[close].type === 'punct' && OPENERS.has(sig[close].value)) inner += 1;
            else if (sig[close].type === 'punct' && CLOSERS.has(sig[close].value)) inner -= 1;
            close += 1;
          }
          rekey([j + 1, close], 's');
        }
        nest += 1;
      } else if (u.type === 'punct' && CLOSERS.has(u.value)) {
        if (nest === 0) return;
        nest -= 1;
      } else if (atKey && isPunct(sig[j + 1], ':')) {
        if (isLiteral(u)) rekey([j, j + 1], 's');
        else if (u.type === 'num' && ID.test(u.value)) hand.push(`${rel}:${lineOf(u.start)} s: a numeric key`);
        else if (u.type === 'word') hand.push(`${rel}:${lineOf(u.start)} s: the key ${u.value}`);
      } else if (atKey && u.type === 'punct' && u.value === '...') {
        hand.push(`${rel}:${lineOf(u.start)} s: a spread in a seeded store`);
      }
    }
  };

  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    const next = sig[k + 1];
    if (t.type === 'word' && t.value in HOLDER_ARG && isPunct(next, '(') && (isPunct(sig[k - 1], '.') || isPunct(sig[k - 1], '?.'))) {
      rekey(argSpan(k + 1, HOLDER_ARG[t.value]), 'm');
      if (t.value === 'initiatePaidSubscription') buyer(argSpan(k + 1, 3));
    }
    if (t.type === 'word' && t.value in RENAMED && (isPunct(sig[k - 1], '.') || isPunct(sig[k - 1], '?.'))) {
      edits.push({ cls: 'r', start: t.start, end: t.end, text: RENAMED[t.value] });
    }
    if (t.type === 'str' && t.value in RENAMED && !isPunct(next, ':')) {
      edits.push({ cls: 'r', start: t.start, end: t.end, text: RENAMED[t.value] });
    }
    if (t.type === 'str' && /^premium\./.test(t.value) && t.value.slice(8) in HOLDER_ARG) {
      let j = k + 1;
      while (sig[j] && (isPunct(sig[j], ',') || isPunct(sig[j], ':') || isPunct(sig[j], '{') || (sig[j].type === 'word' && sig[j].value === 'args'))) j += 1;
      if (isPunct(sig[j], '[')) {
        rekey(argSpan(j, HOLDER_ARG[t.value.slice(8)]), 'o');
        if (t.value === 'premium.initiatePaidSubscription') buyer(argSpan(j, 3));
      } else if (isPunct(sig[k - 1], '(') && isPunct(next, ',') && !isPunct(sig[k + 2], '{')) {
        // A row's own helper that takes the op's name and then its arguments: op('premium.grantManual', G, 'low', 30).
        rekey(argSpan(k - 1, HOLDER_ARG[t.value.slice(8)] + 1), 'o');
        if (t.value === 'premium.initiatePaidSubscription') buyer(argSpan(k - 1, 4));
      } else {
        hand.push(`${rel}:${lineOf(t.start)} o: the args of ${t.value} are not an array literal here`);
      }
    }
    if (t.type === 'word' && t.value === 'subscriptions') {
      const open = isPunct(next, '[') ? k + 1 : isPunct(next, '?.') && isPunct(sig[k + 2], '[') ? k + 2 : -1;
      if (open >= 0) {
        let close = open + 1;
        let inner = 0;
        while (sig[close] && !(inner === 0 && isPunct(sig[close], ']'))) {
          if (sig[close].type === 'punct' && OPENERS.has(sig[close].value)) inner += 1;
          else if (sig[close].type === 'punct' && CLOSERS.has(sig[close].value)) inner -= 1;
          close += 1;
        }
        rekey([open + 1, close], 'k');
      }
      if (isPunct(next, ':') && isPunct(sig[k + 2], '{')) seedKeys(k + 2);
    }
    if (t.type === 'word' && t.value === 'writePremium' && isPunct(next, '(') && isPunct(sig[k + 2], '{')) seedKeys(k + 2);
    if (t.type === 'word' && t.value === 'subscriptions' && isPunct(next, '=') && isPunct(sig[k + 2], '{')) seedKeys(k + 2);
    // A record seeded outside those two places (a helper that returns the store's map): a key whose value is an
    // object literal that starts with a record's own key.
    if (isLiteral(t) && ID.test(t.value) && isPunct(next, ':') && isPunct(sig[k + 2], '{') && sig[k + 3] && sig[k + 3].type === 'word' && RECORD_KEYS.has(sig[k + 3].value) && (isPunct(sig[k - 1], '{') || isPunct(sig[k - 1], ','))) {
      rekey([k, k + 1], 's');
    }
    if (isPunct(t, '[') && (isPunct(sig[k - 1], '{') || isPunct(sig[k - 1], ',')) && sig[k + 1] && sig[k + 1].type === 'word' && isPunct(sig[k + 2], ']') && isPunct(sig[k + 3], ':') && isPunct(sig[k + 4], '{') && sig[k + 5] && sig[k + 5].type === 'word' && RECORD_KEYS.has(sig[k + 5].value)) {
      rekey([k + 1, k + 2], 's');
    }
  }

  function buyer(span) {
    if (!span) return;
    let nest = 0;
    for (let j = span[0]; j < span[1]; j++) {
      const u = sig[j];
      if (u.type === 'punct' && OPENERS.has(u.value)) nest += 1;
      else if (u.type === 'punct' && CLOSERS.has(u.value)) nest -= 1;
      else if (nest === 1 && u.type === 'word' && u.value === 'userId' && (isPunct(sig[j - 1], '{') || isPunct(sig[j - 1], ','))) {
        edits.push({ cls: 'b', start: u.start, end: u.end, text: isPunct(sig[j + 1], ':') ? 'buyerId' : 'buyerId: userId' });
      }
    }
  }

  // One edit per place: two classes can name the same token (a seed key inside writePremium's subscriptions).
  const seen = new Set();
  const unique = edits.filter(e => {
    const key = `${e.start}:${e.end}:${e.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let at = 0;
  for (const e of unique) {
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  out += text.slice(at);
  if (needsImport && !/import \{[^}]*\bgh\b[^}]*\} from '[^']*p1Holder'/.test(out)) {
    const from = rel.startsWith('helpers/') ? './p1Holder' : '../helpers/p1Holder';
    const imports = [...out.matchAll(/^import [^\n]*\n/gm)];
    const lastImport = imports[imports.length - 1];
    if (!lastImport) hand.push(`${rel}: gh(...) is used and the file has no import line to put its import after`);
    else {
      const where = lastImport.index + lastImport[0].length;
      out = out.slice(0, where) + `import { gh } from '${from}';\n` + out.slice(where);
    }
  }
  const counts = {};
  for (const e of unique) if (e.cls) counts[e.cls] = (counts[e.cls] || 0) + 1;
  const before = text.split('\n');
  const changedLines = new Set(unique.map(e => lineOf(e.start)));
  const expectLines = [...changedLines].sort((a, b) => a - b).filter(n => /\bexpect\b/.test(before[n - 1])).map(n => `${rel}:${n}: ${before[n - 1].trim()}`);
  return { rel, text, out, counts, hand, expectLines, edits: unique.length };
}

const EVENT_TYPE = /^subscription\.(created|renewed|expired|cancelled|updated|paused|resumed|renewal-failed)$/;
const EVENT_BUYER = '80000000000000001';

function eventFileList(only) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/^p1[A-Z]/.test(e.name)) out.push(p);
    }
  };
  for (const d of DIRS) walk(path.join(ROOT, d));
  return out
    .filter(file => /'subscription\.(created|renewed|expired|cancelled|updated|paused|resumed|renewal-failed)'|initiatePaidSubscription/.test(fs.readFileSync(file, 'utf8')))
    .filter(file => !only || file.replace(/\\/g, '/').includes(only))
    .sort();
}

function planEvent(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const sig = lex(text).filter(t => t.type !== 'comment');
  const edits = [];
  const hand = [];
  const lineOf = offset => text.slice(0, offset).split('\n').length;
  let needsImport = false;
  const isOpen = t => t.type === 'punct' && OPENERS.has(t.value);
  const isClose = t => t.type === 'punct' && CLOSERS.has(t.value);
  // The index of the `{` that encloses the token at `k`, and of its `}`; null outside any object.
  const enclosing = k => {
    let nest = 0;
    let open = -1;
    for (let j = k - 1; j >= 0; j--) {
      if (isClose(sig[j])) nest += 1;
      else if (isOpen(sig[j])) {
        if (nest === 0) { open = j; break; }
        nest -= 1;
      }
    }
    if (open < 0 || !isPunct(sig[open], '{')) return null;
    nest = 0;
    for (let j = open + 1; j < sig.length; j++) {
      if (isOpen(sig[j])) nest += 1;
      else if (isClose(sig[j])) {
        if (nest === 0) return [open, j];
        nest -= 1;
      }
    }
    return null;
  };
  // The top-level keys of the object [open, close]: name -> index of the key token.
  const keysOf = (open, close) => {
    const keys = Object.create(null);
    let nest = 0;
    for (let j = open + 1; j < close; j++) {
      const u = sig[j];
      if (isOpen(u)) { nest += 1; continue; }
      if (isClose(u)) { nest -= 1; continue; }
      if (nest !== 0) continue;
      const atKey = isPunct(sig[j - 1], '{') || isPunct(sig[j - 1], ',');
      if (atKey && (u.type === 'word' || u.type === 'str') && (isPunct(sig[j + 1], ':') || isPunct(sig[j + 1], ',') || j + 1 === close)) keys[u.value] = j;
      if (atKey && isPunct(u, '...')) keys['...'] = j;
    }
    return keys;
  };
  // The end (exclusive token index) of the value that starts at `from` inside the object that closes at `close`.
  const valueEnd = (from, close) => {
    let nest = 0;
    for (let j = from; j < close; j++) {
      if (isOpen(sig[j])) nest += 1;
      else if (isClose(sig[j])) nest -= 1;
      else if (nest === 0 && isPunct(sig[j], ',')) return j;
    }
    return close;
  };
  const toHolder = (from, to, cls) => {
    const first = sig[from];
    const last = sig[to - 1];
    if (to - from === 1 && isLiteral(first)) {
      if (/^(guild|user):/.test(first.value)) return true;
      if (/^[1-9][0-9]{0,19}$/.test(first.value)) { edits.push({ cls: null, start: first.start, end: first.start, text: 'guild:' }); return true; }
      hand.push(`${rel}:${lineOf(first.start)} ${cls}: the literal '${first.value}' is no Discord id`);
      return false;
    }
    if (first.type === 'word' && (first.value === 'gh' || first.value === 'uh') && isPunct(sig[from + 1], '(')) return true;
    const quote = t => (t.type === 'str' || t.type === 'quasi' ? 1 : 0);
    edits.push({ cls: null, start: first.start - quote(first), end: first.start - quote(first), text: 'gh(' });
    edits.push({ cls: null, start: last.end + quote(last), end: last.end + quote(last), text: ')' });
    needsImport = true;
    return true;
  };

  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (t.type === 'str' && EVENT_TYPE.test(t.value) && isPunct(sig[k - 1], ':') && sig[k - 2] && sig[k - 2].type === 'word' && sig[k - 2].value === 'type') {
      const span = enclosing(k);
      if (!span) continue;
      const [open, close] = span;
      const keys = keysOf(open, close);
      if (!Object.hasOwn(keys, 'providerSubId') && !Object.hasOwn(keys, '...')) {
        hand.push(`${rel}:${lineOf(t.start)} e: an object with the type ${t.value} and no providerSubId (not an event literal)`);
        continue;
      }
      if (Object.hasOwn(keys, 'guildId')) {
        const at = keys.guildId;
        const key = sig[at];
        if (isPunct(sig[at + 1], ':')) {
          if (toHolder(at + 2, valueEnd(at + 2, close), 'e')) edits.push({ cls: 'e', start: key.start, end: key.end, text: 'holder' });
        } else {
          edits.push({ cls: 'e', start: key.start, end: key.end, text: 'holder: gh(guildId)' });
          needsImport = true;
        }
      } else if (!Object.hasOwn(keys, 'holder') && !Object.hasOwn(keys, '...')) {
        hand.push(`${rel}:${lineOf(t.start)} e: a ${t.value} literal with no guildId and no holder`);
      }
      if (t.value === 'subscription.created' && !Object.hasOwn(keys, 'buyerId')) {
        if (isPunct(sig[k + 1], ',') || k + 1 === close) edits.push({ cls: 'c', start: t.end + 1, end: t.end + 1, text: `, buyerId: '${EVENT_BUYER}'` });
        else hand.push(`${rel}:${lineOf(t.start)} c: a created event whose type is not followed by a comma`);
      }
    }
    const purchase = (open, index, line) => {
      const span = argSpanOf(sig, open, index);
      if (!span) { hand.push(`${rel}:${line} p: a purchase with no options argument`); return; }
      if (!isPunct(sig[span[0]], '{')) { hand.push(`${rel}:${line} p: the options of a purchase are not an object literal here`); return; }
      const keys = keysOf(span[0], span[1] - 1);
      if (Object.hasOwn(keys, 'buyerId')) return;
      const brace = sig[span[0]];
      const empty = span[1] - span[0] === 2;
      edits.push({ cls: 'p', start: brace.end, end: brace.end, text: empty ? ` buyerId: '${EVENT_BUYER}' ` : ` buyerId: '${EVENT_BUYER}',` });
    };
    if (t.type === 'word' && t.value === 'initiatePaidSubscription' && isPunct(sig[k + 1], '(') && (isPunct(sig[k - 1], '.') || isPunct(sig[k - 1], '?.'))) {
      purchase(k + 1, 3, lineOf(t.start));
    }
    if (t.type === 'str' && t.value === 'premium.initiatePaidSubscription') {
      let j = k + 1;
      while (sig[j] && (isPunct(sig[j], ',') || isPunct(sig[j], ':') || isPunct(sig[j], '{') || (sig[j].type === 'word' && sig[j].value === 'args'))) j += 1;
      if (isPunct(sig[j], '[')) purchase(j, 3, lineOf(t.start));
      else if (isPunct(sig[k - 1], '(') && isPunct(sig[k + 1], ',') && !isPunct(sig[k + 2], '{')) purchase(k - 1, 4, lineOf(t.start));
      else hand.push(`${rel}:${lineOf(t.start)} p: the args of ${t.value} are not an array literal here`);
    }
  }

  const seen = new Set();
  const unique = edits.filter(e => {
    const key = `${e.start}:${e.end}:${e.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let at = 0;
  for (const e of unique) {
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  out += text.slice(at);
  if (needsImport && !/import \{[^}]*\bgh\b[^}]*\} from '[^']*p1Holder'/.test(out)) {
    const from = rel.startsWith('helpers/') ? './p1Holder' : '../helpers/p1Holder';
    const imports = [...out.matchAll(/^import [^\n]*\n/gm)];
    const lastImport = imports[imports.length - 1];
    if (!lastImport) hand.push(`${rel}: gh(...) is used and the file has no import line to put its import after`);
    else {
      const where = lastImport.index + lastImport[0].length;
      out = out.slice(0, where) + `import { gh } from '${from}';\n` + out.slice(where);
    }
  }
  const counts = {};
  for (const e of unique) if (e.cls) counts[e.cls] = (counts[e.cls] || 0) + 1;
  const before = text.split('\n');
  const changedLines = new Set(unique.map(e => lineOf(e.start)));
  const expectLines = [...changedLines].sort((a, b) => a - b).filter(n => /\bexpect\b/.test(before[n - 1])).map(n => `${rel}:${n}: ${before[n - 1].trim()}`);
  return { rel, text, out, counts, hand, expectLines, edits: unique.length };
}

// The token span [from, to) of the argument `index` of the list opened at `open`; null when it has none.
function argSpanOf(sig, open, index) {
  let nest = 0;
  let at = 0;
  let from = open + 1;
  for (let k = open + 1; k < sig.length; k++) {
    const t = sig[k];
    if (t.type !== 'punct') continue;
    if (OPENERS.has(t.value)) { nest += 1; continue; }
    if (CLOSERS.has(t.value)) {
      if (nest === 0) return at === index && k > from ? [from, k] : null;
      nest -= 1;
      continue;
    }
    if (t.value === ',' && nest === 0) {
      if (at === index) return [from, k];
      at += 1;
      from = k + 1;
    }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'manager' && args[0] !== 'event') throw new Error('usage: node p1Rekey.cjs manager|event --plan|--apply [--only <path part>]');
  const eventMode = args[0] === 'event';
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const apply = args.includes('--apply');
  const plan = eventMode ? planEvent : planManager;
  const total = {};
  let files = 0;
  const hand = [];
  const expects = [];
  for (const file of (eventMode ? eventFileList : fileList)(only)) {
    const p = plan(file);
    hand.push(...p.hand);
    if (p.edits === 0) continue;
    files += 1;
    expects.push(...p.expectLines);
    for (const [cls, n] of Object.entries(p.counts)) total[cls] = (total[cls] || 0) + n;
    console.log(`${p.rel}: ${Object.entries(p.counts).map(([c, n]) => `${c}=${n}`).join(' ')}`);
    if (apply) {
      fs.writeFileSync(file, p.out);
      const again = plan(file);
      if (again.edits !== 0) throw new Error(`${p.rel}: ${again.edits} edit(s) still planned after the apply`);
    }
  }
  console.log(`\n${apply ? 'Applied' : 'Planned'}: ${files} file(s), ${Object.entries(total).map(([c, n]) => `${c}=${n}`).join(' ') || 'nothing to do'}`);
  console.log(`\nChanged lines that hold expect (${expects.length}):`);
  for (const line of expects) console.log(line);
  console.log(`\nLeft for a hand edit (${hand.length}):`);
  for (const line of hand) console.log(line);
}

main();
