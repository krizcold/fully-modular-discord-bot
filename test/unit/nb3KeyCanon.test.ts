import path from 'path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalGuildKey, GuildKeyError, isCanonicalGuildKey } from '../../src/bot/internalSetup/utils/dataKeys';

// NB3 decision 8: one canonical form for a guild key (category and filename joined, normalized, split at the first '/').

const segment = fc.constantFrom('a', 'b', 'mod', 'x.json', 'y.jsonl', '.', '..', '');
const rawKey = fc.array(segment, { minLength: 1, maxLength: 5 }).map(parts => parts.join('/'));
const withTail = fc.tuple(rawKey, fc.boolean(), fc.boolean()).map(([k, slashTail, doubled]) => {
  const key = doubled ? k.replace('/', '//') : k;
  return slashTail ? `${key}/` : key;
});

function tryCanon(category: string, filename: string): { module: string; filename: string } | null {
  try {
    return canonicalGuildKey(category, filename);
  } catch (error) {
    expect(error).toBeInstanceOf(GuildKeyError);
    return null;
  }
}

describe('the canonical guild key', () => {
  it('splits at the first slash; one segment is module ""', () => {
    expect(canonicalGuildKey('', 'mod/id.json')).toEqual({ module: 'mod', filename: 'id.json' });
    expect(canonicalGuildKey('mod', 'id.json')).toEqual({ module: 'mod', filename: 'id.json' });
    expect(canonicalGuildKey(undefined, 'top.json')).toEqual({ module: '', filename: 'top.json' });
    expect(canonicalGuildKey('mod', 'sub/deep.json')).toEqual({ module: 'mod', filename: 'sub/deep.json' });
    expect(canonicalGuildKey('mod//', './x.json')).toEqual({ module: 'mod', filename: 'x.json' });
  });

  it('refuses a key that leaves the guild folder, ends in "/", starts with "/", holds a backslash or is empty', () => {
    for (const [c, f] of [['', '../x.json'], ['mod', '../../x'], ['mod', 'x/'], ['', '/abs'], ['mod', 'a\\b'], ['', ''], ['', '.'], ['mod', '..']]) {
      expect(() => canonicalGuildKey(c, f)).toThrow(GuildKeyError);
    }
  });

  it('property: the canonical key is a fixed point', () => {
    fc.assert(fc.property(withTail, withTail, (category, filename) => {
      const c = tryCanon(category, filename);
      if (!c) return;
      expect(canonicalGuildKey(c.module, c.filename)).toEqual(c);
      expect(isCanonicalGuildKey(c.module, c.filename)).toBe(true);
    }));
  });

  it('property: two keys share a canonical key exactly when path.join gives them one path', () => {
    fc.assert(fc.property(withTail, withTail, withTail, withTail, (c1, f1, c2, f2) => {
      const a = tryCanon(c1, f1);
      const b = tryCanon(c2, f2);
      if (!a || !b) return;
      const pa = path.posix.join('/g', c1, f1);
      const pb = path.posix.join('/g', c2, f2);
      expect(a.module === b.module && a.filename === b.filename).toBe(pa === pb);
    }));
  });

  it('property: a refused key either leaves the guild folder or ends in "/" (or is empty)', () => {
    fc.assert(fc.property(withTail, withTail, (category, filename) => {
      if (tryCanon(category, filename)) return;
      const joined = category ? `${category}/${filename}` : filename;
      const normal = path.posix.normalize(joined);
      expect(joined === '' || joined.startsWith('/') || joined.endsWith('/') || normal === '.'|| normal === '..' || normal.startsWith('../')).toBe(true);
    }));
  });
});
