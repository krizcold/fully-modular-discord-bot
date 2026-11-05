import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decodeStorable,
  fold,
  keyRefusal,
  KeyTree,
  sizeRefusal,
  STORE_MAX_BYTES,
  textRefusal,
  utf8Pieces,
  valueText,
} from '../../src/bot/internalSetup/utils/storableData';

// NB12 item 1: the pure rule module (wip-redesign/sheets/NB12.md, decisions 2, 4, 5, 7 and 8).

describe('rule T, the text', () => {
  it.each([
    ['', null],
    ['abc', null],
    ['\uD83D\uDE00', null],
  ])('passes %j', (text, expected) => {
    expect(textRefusal(text)).toBe(expected);
  });

  it.each([
    ['\u0000abc', 0],
    ['ab\u0000c', 2],
    ['abc\u0000', 3],
  ])('refuses U+0000 in %j naming character %i', (text, at) => {
    expect(textRefusal(text)).toBe(`it holds U+0000 at character ${at}, which the database cannot store`);
  });

  it.each([
    ['\uD800', 'D800', 0],
    ['\uDC00', 'DC00', 0],
    ['\uDC00\uD800', 'DC00', 0],
    ['a\uD83D', 'D83D', 1],
  ])('refuses the unpaired surrogate in %j', (text, code, at) => {
    expect(textRefusal(text)).toBe(`it holds an unpaired surrogate (U+${code}) at character ${at}, which no store keeps as written`);
  });

  it.each([[5], [{ a: 1 }], [undefined]])('refuses %j as a line that is not a string', line => {
    expect(textRefusal(line)).toBe('the line is not a string');
  });

  it('refuses exactly what a UTF-8 round trip would alter or the database refuses (property)', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), s => {
      const refused = textRefusal(s) !== null;
      expect(refused).toBe(s.includes('\u0000') || !s.isWellFormed());
      if (!refused) expect(Buffer.from(s, 'utf8').toString('utf8')).toBe(s);
    }), { numRuns: 500 });
  });
});

describe('the bytes rule', () => {
  it('keeps a BOM and CRLF text unchanged', () => {
    const bytes = Buffer.from('\uFEFF{"a":1}\r\n', 'utf8');
    expect(decodeStorable(bytes)).toEqual({ ok: true, text: '\uFEFF{"a":1}\r\n' });
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(decodeStorable(Buffer.from([0xc3, 0x28]))).toEqual({ ok: false, reason: 'it is not valid UTF-8 text' });
  });

  it('refuses a 0x00 byte naming U+0000', () => {
    const answer = decodeStorable(Buffer.from([0x61, 0x00]));
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.reason).toMatch(/U\+0000/);
  });
});

describe('rule V, the value', () => {
  it.each([[undefined], [() => 1], [Symbol('s')], [{ toJSON: () => undefined }]])('refuses a value with no JSON form', value => {
    expect(valueText(value)).toEqual({ ok: false, reason: 'the value has no JSON form (it is undefined, a function or a symbol)' });
  });

  it('refuses a value whose stringify throws, with the error', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [{ n: 1n }, cycle]) {
      const answer = valueText(value);
      expect(answer.ok).toBe(false);
      expect(!answer.ok && answer.reason).toMatch(/^the value cannot be written as JSON \(.+\)$/);
    }
  });

  it('keeps U+0000 and lone surrogates inside a JSON string as escapes', () => {
    const answer = valueText({ a: '\u0000\uD800' });
    expect(answer.ok && JSON.parse(answer.text)).toEqual({ a: '\u0000\uD800' });
  });
});

describe('rule S, the size', () => {
  it('passes the cap and refuses one byte more', () => {
    expect(sizeRefusal('a'.repeat(10), 10)).toBeNull();
    expect(sizeRefusal('a'.repeat(11), 10)).toMatch(/one write holds at most/);
  });

  it('defaults to 4 MiB of UTF-8', () => {
    expect(STORE_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(sizeRefusal('a'.repeat(STORE_MAX_BYTES))).toBeNull();
    expect(sizeRefusal('a'.repeat(STORE_MAX_BYTES + 1))).toBe('it is 4.01 MiB; one write holds at most 4 MiB');
    expect(sizeRefusal('\u20AC'.repeat(STORE_MAX_BYTES / 3 + 1))).not.toBeNull();
  });
});

describe('rule K, the key', () => {
  const seg = (n: number) => 'a'.repeat(n);

  it.each([
    [seg(200), true],
    [seg(201), false],
    ['\u20AC'.repeat(66), true],
    ['\u20AC'.repeat(67), false],
    [`${seg(200)}/${seg(200)}/${seg(200)}/${seg(200)}/${seg(200)}/${seg(19)}`, true],
    [`${seg(200)}/${seg(200)}/${seg(200)}/${seg(200)}/${seg(200)}/${seg(20)}`, false],
    ['x.tmp', false],
    ['mod/a/x.tmp', false],
    ['mod.tmp/x.json', false],
    ['a/b.tmp/c.json', false],
    ['x.tmpl', true],
    ['tmp', true],
    ['mod/tmp.json', true],
    ['.graveyard.json', false],
    ['.Graveyard.json', false],
    ['.graveyard.j\u017Fon', false],
    ['.graveyard.json/x.json', false],
    ['mod/.graveyard.json', true],
    ...[...'<>:"|?*'].map(c => [`m/a${c}b.json`, false] as [string, boolean]),
    ['m/a\u0001.json', false],
    ['m/a\u001F.json', false],
    ['m/a.', false],
    ['m/a ', false],
    ['CON', false],
    ['con.json', false],
    ['Lpt9.txt', false],
    ['m/aux/x.json', false],
    ['CONSOLE.json', true],
    ['com10.json', true],
    ['m/a\u0000.json', false],
    ['m\u0000/a.json', false],
    ['m/a\uD800.json', false],
    ['m\uDC00/a.json', false],
  ])('%j passes: %s', (key, passes) => {
    expect(keyRefusal(key) === null).toBe(passes);
  });

  it('checks the kind of a write that names it', () => {
    expect(keyRefusal('log.jsonl', 'save')).toBe('a .jsonl file is written by appends only');
    expect(keyRefusal('log.txt', 'append')).toBe('an appended file must end in .jsonl');
    expect(keyRefusal('m/log.jsonl', 'append')).toBeNull();
    expect(keyRefusal('m/log.jsonl')).toBeNull();
  });

  it('names the part and the rule', () => {
    expect(keyRefusal('cache.tmp/x.json')).toBe('the part "cache.tmp" ends in ".tmp", which marks an interrupted write');
    expect(keyRefusal('m/a:b.json')).toBe('the part "a:b.json" holds ":", which a Windows file name cannot hold');
  });
});

describe('the fold', () => {
  it('merges every pair either case mapping merges, over every code point', () => {
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      const f = fold(c);
      if (f !== fold(c.toLowerCase()) || f !== fold(c.toUpperCase())) throw new Error(`U+${cp.toString(16)} folds apart`);
    }
  });

  it.each([
    ['i', '\u0131'],
    ['s', '\u017F'],
    ['\u00B5', '\u03BC'],
    ['\u03C2', '\u03C3'],
    ['\u00DF', '\u1E9E'],
  ])('folds %j and %j equal', (a, b) => {
    expect(fold(a)).toBe(fold(b));
  });
});

describe('KeyTree.check', () => {
  const treeOf = (keys: string[]) => {
    const tree = new KeyTree();
    for (const k of keys) tree.add(k);
    return tree;
  };

  it.each([
    [['m/a/x.json'], 'm/a', 'm/a'],
    [['m/a'], 'm/a/x.json', 'm/a'],
    [['m/a.json'], 'm/A.json', 'm/a.json'],
    [['m/Users/1.json'], 'm/users/2.json', 'm/Users'],
    [['words/kir.json'], 'words/k\u0131r.json', 'words/kir.json'],
    [['m/s.json'], 'm/\u017F.json', 'm/s.json'],
    [['m/\u00B5.json'], 'm/\u03BC.json', 'm/\u00B5.json'],
    [['m/\u03B1\u03C2.json'], 'm/\u03B1\u03C3.json', 'm/\u03B1\u03C2.json'],
  ])('%j refuses %j naming %j', (keys, key, named) => {
    const collision = treeOf(keys).check(key);
    expect(collision).not.toBeNull();
    expect(collision!.reason).toContain(named);
    expect(collision!.entry).toBe(named);
  });

  it.each([
    [['m/a.json'], 'm/a.json'],
    [['m/ab/x.json'], 'm/a'],
  ])('%j passes %j', (keys, key) => {
    expect(treeOf(keys).check(key)).toBeNull();
  });

  it('forgets a folder once its last key is removed', () => {
    const tree = treeOf(['m/a/x.json']);
    tree.remove('m/a/x.json');
    expect(tree.check('m/a')).toBeNull();
    expect(tree.check('M/b.json')).toBeNull();
  });

  it('holds stored pairs as a multiset of spellings', () => {
    const pair = new KeyTree();
    expect(pair.add('m/a.json')).toBeNull();
    expect(pair.add('m/A.json')).not.toBeNull();
    expect(pair.check('m/a.json')).toBeNull();
    expect(pair.check('m/A.json')).toBeNull();
    pair.remove('m/A.json');
    expect(pair.check('m/a.json/x')?.reason).toBe('the folder m/a.json of it is a file');
    expect(pair.check('m/A.json')?.entry).toBe('m/a.json');

    const folders = new KeyTree();
    folders.add('M/x.json');
    expect(folders.add('m/y.json')).not.toBeNull();
    expect(folders.check('m/z.json')).toBeNull();
    expect(folders.check('M/z.json')).toBeNull();
    expect(folders.check('M/x.json/q')).not.toBeNull();

    const fileAndFolder = new KeyTree();
    fileAndFolder.add('m/a');
    expect(fileAndFolder.add('m/a/x.json')).not.toBeNull();
    expect(fileAndFolder.check('m/a')).toBeNull();
    expect(fileAndFolder.check('m/a/x.json')).toBeNull();
    expect(fileAndFolder.check('m/a/y.json')).not.toBeNull();
  });

  it('answers on a kept tree as on one built fresh from the same keys (property)', () => {
    const fixed = fc.constantFrom('a', 'A', 'b', 'k\u0131r', 'kir', 'x.json', 'X.JSON', '\u017F', 's', '\u212A', 'k', '\u00DF', '\u1E9E', 'ss');
    const drawn = fc.string({ unit: 'binary', minLength: 1, maxLength: 3 }).filter(p => !p.includes('/'));
    const part = fc.tuple(fc.oneof(fixed, drawn), fc.constantFrom('as drawn', 'upper', 'lower'))
      .map(([p, c]) => (c === 'upper' ? p.toUpperCase() : c === 'lower' ? p.toLowerCase() : p));
    const key = fc.array(part, { minLength: 1, maxLength: 3 }).map(p => p.join('/'));
    const step = fc.oneof(
      fc.record({ op: fc.constant('add' as const), key }),
      fc.record({ op: fc.constant('remove' as const), key }),
      fc.record({ op: fc.constant('check' as const), key }),
    );
    fc.assert(fc.property(fc.array(key, { maxLength: 4 }), fc.array(step, { maxLength: 30 }), (start, steps) => {
      const kept = treeOf(start);
      const live = new Set(start);
      const accepted = new KeyTree();
      const acceptedKeys = new Set<string>();
      for (const s of steps) {
        if (s.op === 'add') {
          kept.add(s.key);
          live.add(s.key);
        } else if (s.op === 'remove') {
          kept.remove(s.key);
          live.delete(s.key);
        }
        const fresh = treeOf([...live]);
        const was = kept.check(s.key);
        const now = fresh.check(s.key);
        expect(was === null).toBe(now === null);
        if (was && now) expect([was.entryKind, fold(was.entry)]).toEqual([now.entryKind, fold(now.entry)]);
        for (const k of live) expect(kept.check(k)).toBeNull();
        if (accepted.check(s.key) === null && !acceptedKeys.has(s.key)) {
          accepted.add(s.key);
          acceptedKeys.add(s.key);
        }
      }
      const rebuilt = new KeyTree();
      for (const k of acceptedKeys) expect(rebuilt.add(k)).toBeNull();
    }), { numRuns: 300 });
  });

  it('costs a fixed number of map lookups and iterator steps per segment, whatever the size', () => {
    const treeOfSize = (n: number) => {
      const tree = new KeyTree();
      for (let i = 0; i < n; i++) tree.add(`m/users/${i}.json`);
      return tree;
    };
    const count = (fn: () => void): number => {
      const mapIter = Object.getPrototypeOf(new Map().entries());
      const setIter = Object.getPrototypeOf(new Set().values());
      const saved = ([
        [Map.prototype, 'get'], [Map.prototype, 'has'], [Set.prototype, 'has'], [Map.prototype, 'forEach'], [Set.prototype, 'forEach'],
        [mapIter, 'next'], [setIter, 'next'],
      ] as Array<[any, string]>).map(([holder, name]) => [holder, name, holder[name]] as const);
      let n = 0;
      for (const [holder, name, real] of saved) holder[name] = function (this: unknown, ...args: unknown[]) { n++; return real.apply(this, args); };
      try { fn(); } finally {
        for (const [holder, name, real] of saved) holder[name] = real;
      }
      return n;
    };
    const small = treeOfSize(1_000);
    const large = treeOfSize(100_000);
    for (const key of ['m/users/new.json', 'm/users/5.json', 'M/Users/new.json']) {
      const atLarge = count(() => large.check(key));
      expect(atLarge).toBeLessThanOrEqual(3 * 8);
      expect(atLarge).toBe(count(() => small.check(key)));
    }
  });
});

describe('the flush pieces', () => {
  it('cuts only between code points, in order', () => {
    const text = `${'a'.repeat(5)}\uD83D\uDE00${'b'.repeat(5)}`;
    const pieces = utf8Pieces(text, 7);
    expect(pieces.join('')).toBe(text);
    for (const p of pieces) {
      expect(p.isWellFormed()).toBe(true);
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(7);
    }
  });
});
