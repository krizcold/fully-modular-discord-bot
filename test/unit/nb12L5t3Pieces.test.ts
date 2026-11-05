import { describe, expect, it } from 'vitest';
import { KeyTree, utf8Pieces } from '../../src/bot/internalSetup/utils/storableData';

// NB12 survivors, chunk 3: the key tree's count and case reason, and the flush pieces (sheet decision 8).

function greedy(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  const out: string[] = [];
  let cur = '';
  for (const cp of text) {
    const size = Buffer.byteLength(cp, 'utf8');
    if (cur !== '' && Buffer.byteLength(cur, 'utf8') + size > maxBytes) {
      out.push(cur);
      cur = '';
    }
    cur += cp;
  }
  if (cur !== '') out.push(cur);
  return out;
}

function expectPieces(text: string, maxBytes: number, expected: string[]): void {
  const pieces = utf8Pieces(text, maxBytes);
  expect(pieces).toEqual(expected);
  expect(pieces).toEqual(greedy(text, maxBytes));
  expect(pieces.join('')).toBe(text);
  for (const p of pieces) {
    expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(Math.max(maxBytes, 4));
    if (text.isWellFormed()) expect(p.isWellFormed()).toBe(true);
  }
}

describe('the key tree', () => {
  it('counts every exact key it holds', () => {
    const tree = new KeyTree();
    tree.add('m/a.json');
    tree.add('m/b.json');
    tree.add('n.json');
    expect(tree.size).toBe(3);
    tree.remove('m/a.json');
    expect(tree.size).toBe(2);
  });

  it('names the file a key folder differs from only in letter case', () => {
    const tree = new KeyTree();
    tree.add('m');
    expect(tree.check('M/b.json')).toEqual({ reason: 'it differs only in letter case from m', entry: 'm', entryKind: 'file' });
  });
});

describe('the flush pieces', () => {
  it('keeps an empty text as one empty piece when it fits', () => {
    expect(utf8Pieces('')).toEqual(['']);
    expect(utf8Pieces('', 0)).toEqual(['']);
  });

  it('gives no piece over a cap below zero', () => {
    const pieces = utf8Pieces('', -1);
    expect(pieces).toEqual([]);
    for (const p of pieces) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(-1);
  });

  it('fills each piece up to the cap and no further', () => {
    expectPieces('abc', 2, ['ab', 'c']);
    expectPieces('ab', 2, ['ab']);
  });

  it('never makes an empty piece for a code point larger than the cap', () => {
    expectPieces('ࠀa', 2, ['ࠀ', 'a']);
  });

  it('counts two bytes for U+0080 to U+07FF', () => {
    expectPieces('ééé', 2, ['é', 'é', 'é']);
    expectPieces('ééé', 4, ['éé', 'é']);
    expectPieces('\u0080\u0080', 2, ['\u0080', '\u0080']);
    expectPieces('߿߿߿', 4, ['߿߿', '߿']);
  });

  it('counts three bytes from U+0800', () => {
    expectPieces('ࠀࠀ', 4, ['ࠀ', 'ࠀ']);
    expectPieces('￿￿', 4, ['￿', '￿']);
  });

  it('keeps every surrogate pair whole at the edges of the range', () => {
    expectPieces('a𐀀', 4, ['a', '𐀀']);
    expectPieces('a􏿿', 4, ['a', '􏿿']);
    expectPieces('a😀', 4, ['a', '😀']);
    expectPieces('😀😀', 4, ['😀', '😀']);
  });

  it('counts a lone surrogate as the three bytes it is written as', () => {
    expectPieces('a\uDC00', 3, ['a', '\uDC00']);
    expectPieces('\uDC00', 3, ['', '\uDC00']);
    expectPieces('\uD800ab', 3, ['\uD800', 'ab']);
    expectPieces('a\uD800', 3, ['a', '\uD800']);
  });
});
