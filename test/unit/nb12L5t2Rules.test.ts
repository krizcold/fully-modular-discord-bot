import { describe, expect, it } from 'vitest';
import { decodeStorable, keyRefusal, KeyTree, textRefusal } from '../../src/bot/internalSetup/utils/storableData';

const ch = (code: number): string => String.fromCharCode(code);
const esc = (code: number): string => ch(92) + 'u' + code.toString(16).toUpperCase().padStart(4, '0');

describe('rule T on surrogates at the edges of their ranges', () => {
  it('refuses a high surrogate followed by a character above the low surrogates', () => {
    const text = ch(0xd800) + ch(0xe000);
    expect(textRefusal(text)).toBe('it holds an unpaired surrogate (U+D800) at character 0, which no store keeps as written');
  });

  it('refuses a lone U+DFFF', () => {
    expect(textRefusal('ab' + ch(0xdfff))).toBe(
      'it holds an unpaired surrogate (U+DFFF) at character 2, which no store keeps as written',
    );
  });

  it('passes a pair whose low half is U+DFFF', () => {
    expect(textRefusal(ch(0xdbff) + ch(0xdfff))).toBeNull();
  });
});

describe('outside bytes holding U+0000', () => {
  it('refuses U+0000 as the first character', () => {
    expect(decodeStorable(Uint8Array.from([0, 0x61]))).toEqual({
      ok: false,
      reason: 'it holds U+0000 at character 0, which the database cannot store',
    });
  });
});

describe('the key part the operator reads in a refusal', () => {
  it('shows a control character as an escape and keeps the other letters', () => {
    expect(keyRefusal('m/ab' + ch(1) + 'c.json')).toBe(
      `the part "ab${esc(1)}c.json" holds the control character U+0001, which a file name cannot hold`,
    );
  });

  it('shows U+001F as an escape', () => {
    expect(keyRefusal('m/a' + ch(0x1f))).toBe(
      `the part "a${esc(0x1f)}" holds the control character U+001F, which a file name cannot hold`,
    );
  });

  it('keeps a space and letters above the surrogates as written beside a control character', () => {
    const seg = ' ' + ch(0xe000) + ch(0xff46) + ch(2);
    expect(keyRefusal(seg)).toBe(
      `the part " ${ch(0xe000)}${ch(0xff46)}${esc(2)}" holds the control character U+0002, which a file name cannot hold`,
    );
  });

  it.each([
    [0xd800],
    [0xdbff],
    [0xdc00],
    [0xdfff],
  ])('shows the lone surrogate %i as an escape', code => {
    expect(keyRefusal('mod/x' + ch(code) + 'y.json')).toBe(
      `the part "x${esc(code)}y.json" holds an unpaired surrogate, which no store keeps as written`,
    );
  });

  it('keeps letters just below the surrogates as written beside a lone surrogate', () => {
    const seg = ch(0xd7ff) + ch(0xdc05) + 'z';
    expect(keyRefusal(seg)).toBe(`the part "${ch(0xd7ff)}${esc(0xdc05)}z" holds an unpaired surrogate, which no store keeps as written`);
  });
});

describe('the folders a key places in the tree', () => {
  it('lets a root key fit beside another root key named as a sentence', () => {
    const tree = new KeyTree();
    tree.add('Stryker was here');
    expect(tree.check('notes.json')).toBeNull();
    expect(tree.add('notes.json')).toBeNull();
  });

  it('makes no folder of the empty name for an ordinary key', () => {
    const tree = new KeyTree();
    tree.add('mod/a.json');
    tree.add('b.json');
    expect(tree.hasFolder('')).toBe(false);
    expect(tree.check('')).toBeNull();
  });

  it('lets a key below a folder fit beside a stored empty key', () => {
    const tree = new KeyTree();
    tree.add('');
    expect(tree.check('mod/a.json')).toBeNull();
  });

  it('counts the empty first part of a key that starts with a slash as a folder', () => {
    const tree = new KeyTree();
    tree.add('/a.json');
    expect(tree.hasFolder('')).toBe(true);
    expect(tree.check('')).toEqual({ reason: ' names a folder that holds other keys', entry: '', entryKind: 'folder' });
  });
});
