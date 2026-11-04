import { describe, expect, it } from 'vitest';
import { canonicalGuildKey, GuildKeyError, isCanonicalGuildKey } from '../../src/bot/internalSetup/utils/dataKeys';

// NB3: a guild key has one canonical form, and a refused key says why in the operator's words.

function refusal(category: string | null, filename: string): GuildKeyError {
  try {
    canonicalGuildKey(category, filename);
  } catch (error) {
    return error as GuildKeyError;
  }
  throw new Error(`the key ${category}/${filename} was accepted`);
}

describe('canonicalGuildKey refusals', () => {
  it('names the error GuildKeyError', () => {
    const err = refusal(null, '');
    expect(err).toBeInstanceOf(GuildKeyError);
    expect(err.name).toBe('GuildKeyError');
  });

  it('refuses an empty key as empty, not as leaving the folder', () => {
    expect(refusal(null, '').message).toBe('[Data] An empty guild key is refused');
    expect(refusal('', '').message).toBe('[Data] An empty guild key is refused');
  });

  it('says what is wrong with each refused key', () => {
    expect(refusal(null, '/x.json').message).toBe('[Data] The guild key "/x.json" starts with "/"; refused');
    expect(refusal('mod', 'a\\b.json').message).toBe('[Data] The guild key "mod/a\\b.json" holds a backslash; refused');
    expect(refusal('mod', 'dir/').message).toBe('[Data] The guild key "mod/dir/" ends in "/"; refused');
    expect(refusal('mod', '../../x.json').message).toBe('[Data] The guild key "mod/../../x.json" leaves the guild folder; refused');
  });

  it('refuses a key that normalizes to the parent folder', () => {
    expect(refusal(null, '..').message).toBe('[Data] The guild key ".." leaves the guild folder; refused');
    expect(refusal('a', '../..').message).toBe('[Data] The guild key "a/../.." leaves the guild folder; refused');
  });
});

describe('isCanonicalGuildKey', () => {
  it('is true only when both parts are already canonical', () => {
    expect(isCanonicalGuildKey('mod', 'x.json')).toBe(true);
    expect(isCanonicalGuildKey('mod', 'sub/x.json')).toBe(true);
  });

  it('is false when only the filename changes on normalizing', () => {
    expect(canonicalGuildKey('a', 'b/../c')).toEqual({ module: 'a', filename: 'c' });
    expect(isCanonicalGuildKey('a', 'b/../c')).toBe(false);
  });

  it('is false when only the module changes on normalizing', () => {
    expect(canonicalGuildKey('./a', 'x')).toEqual({ module: 'a', filename: 'x' });
    expect(isCanonicalGuildKey('./a', 'x')).toBe(false);
  });

  it('is false for a refused key', () => {
    expect(isCanonicalGuildKey('', '')).toBe(false);
    expect(isCanonicalGuildKey('mod', '../../x')).toBe(false);
  });
});
