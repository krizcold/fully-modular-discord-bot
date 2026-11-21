import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  guildHolder, guildIdFor, holderFromWire, holderWords, isDiscordId, parseHolder, userHolder,
} from '../../src/bot/internalSetup/utils/premiumHolder';

// P1 claim 1: a holder key is exactly `guild:` or `user:` and a Discord id (1 to 20 digits, no leading zero).

const X1 = (text: string) => `'${text}' is not a holder: expected guild:<id> or user:<id> with a Discord id.`;

/** The rule written out by hand, so the property does not compare the code with its own pattern. */
function expected(text: string): { kind: 'guild' | 'user'; id: string } | null {
  const kind = text.startsWith('guild:') ? 'guild' : text.startsWith('user:') ? 'user' : null;
  if (!kind) return null;
  const id = text.slice(kind.length + 1);
  if (id.length < 1 || id.length > 20) return null;
  for (const ch of id) if (ch < '0' || ch > '9') return null;
  if (id[0] === '0') return null;
  return { kind, id };
}

describe('P1 claim 1: holder keys', () => {
  it.each([
    ['guild:5', 'guild', '5'],
    ['user:5', 'user', '5'],
    ['user:18446744073709551615', 'user', '18446744073709551615'],
    ['guild:70000000000000001', 'guild', '70000000000000001'],
  ])('%s is a holder', (text, kind, id) => {
    expect(parseHolder(text)).toEqual({ kind, id, key: text });
  });

  it.each([
    ['5'], ['guild:'], ['user:'], ['guild:g1'], ['Guild:5'], ['USER:5'], ['guild:5:6'], ['guild: 5'], [' guild:5'], ['guild:5 '],
    ['guild:5\n'], ['guild:05'], ['guild:0'], ['guild:123456789012345678901'], ['guild:-5'], ['guild:5.0'], ['guild:0665'], [''],
    [null], [undefined], [5], [{ kind: 'guild', id: '5' }], [['guild:5']],
  ])('%j is not a holder', text => {
    expect(parseHolder(text)).toBeNull();
  });

  it('parseHolder accepts a random text only when it is a prefix and a Discord id, and answers the text as the key', () => {
    const digits = fc.array(fc.constantFrom(...'0123456789'), { minLength: 0, maxLength: 22 }).map(a => a.join(''));
    const near = fc.tuple(fc.constantFrom('guild:', 'user:', 'guild', 'Guild:', 'user: ', '', 'guild:guild:'), digits, fc.constantFrom('', '', '', ' ', 'x', ':1'))
      .map(([prefix, id, tail]) => prefix + id + tail);
    fc.assert(fc.property(fc.oneof(fc.string(), near), text => {
      const want = expected(text);
      const got = parseHolder(text);
      if (want === null) return got === null;
      return got !== null && got.kind === want.kind && got.id === want.id && got.key === text;
    }), { numRuns: 2000 });
  });

  it('isDiscordId takes 1 to 20 digits with no leading zero, and only a string', () => {
    expect(['5', '18446744073709551615', '70000000000000001'].map(isDiscordId)).toEqual([true, true, true]);
    expect(['', '0', '05', 'g1', '123456789012345678901', ' 5', '5 ', '5\n', 5, null, undefined, {}].map(isDiscordId)).toEqual(new Array(12).fill(false));
  });

  it('guildHolder and userHolder build the key of a Discord id and throw X1 for anything else', () => {
    expect(guildHolder('5')).toBe('guild:5');
    expect(userHolder('5')).toBe('user:5');
    expect(() => guildHolder('g1')).toThrowError(X1('guild:g1'));
    expect(() => userHolder('05')).toThrowError(X1('user:05'));
    expect(() => guildHolder('')).toThrowError(X1('guild:'));
    expect(() => guildHolder(undefined as any)).toThrowError(/is not a holder: expected guild:<id> or user:<id> with a Discord id\.$/);
  });

  it('holderFromWire answers the server holder of a Discord id, and null without throwing for anything else', () => {
    expect(holderFromWire('70000000000000001')).toBe('guild:70000000000000001');
    const results: unknown[] = [];
    for (const wire of ['', undefined, null, 'g1', '05', 'guild:5', 5, {}, { toString() { throw new Error('read'); } }]) {
      results.push(holderFromWire(wire));
    }
    expect(results).toEqual(new Array(9).fill(null));
  });

  it("guildIdFor returns a server's id, throws X3 for a user and X1 for a text that is no holder", () => {
    expect(guildIdFor('guild:70000000000000001', 'Stripe')).toBe('70000000000000001');
    expect(() => guildIdFor('user:70000000000000001', 'Stripe')).toThrowError('Stripe does not sell user subscriptions.');
    expect(() => guildIdFor('g1' as any, 'Stripe')).toThrowError(X1('g1'));
  });

  it('holderWords names the holder as the logs do', () => {
    expect(holderWords('guild:123')).toBe('guild 123');
    expect(holderWords('user:123')).toBe('user 123');
  });
});
