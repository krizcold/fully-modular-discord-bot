// The lexer of p1Renumber.cjs, for p1Rekey.cjs: strings, templates with their substitutions, regex literals and
// comments as tokens with their offsets.
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


module.exports = { lex, isLiteral, isPunct };
