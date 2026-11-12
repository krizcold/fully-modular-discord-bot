import { describe, expect, it } from 'vitest';
import { toTransport, transportStringify, cutString } from '../../src/bot/internalSetup/utils/transportJson';

const long = 'x'.repeat(3000);
const cut = `${'x'.repeat(1997)}...`;

describe('an answer that fits keeps its payload and cuts its long text fields', () => {
  for (const field of ['error', 'handlerError', 'note']) {
    it(`cuts ${field} to 2000 characters`, () => {
      const { answer, text } = toTransport({ success: false, [field]: long });
      expect(answer[field]).toBe(cut);
      expect(JSON.parse(text)[field]).toBe(cut);
    });
  }

  it('keeps a string of exactly 2000 characters whole', () => {
    const exact = 'y'.repeat(2000);
    expect(cutString(exact)).toBe(exact);
    expect(toTransport({ success: false, error: exact }).answer.error).toBe(exact);
  });

  it('writes a shared object twice when it is no ancestor of itself', () => {
    const shared = { n: 1 };
    expect(transportStringify({ a: shared, b: shared, c: [shared, shared] })).toBe('{"a":{"n":1},"b":{"n":1},"c":[{"n":1},{"n":1}]}');
    const loop: Record<string, unknown> = { n: 2 };
    loop.self = loop;
    expect(transportStringify({ a: loop, b: loop })).toBe('{"a":{"n":2,"self":"[Circular]"},"b":{"n":2,"self":"[Circular]"}}');
  });

  it('writes null for a value JSON has no text for', () => {
    expect(transportStringify(undefined)).toBe('null');
    expect(transportStringify(() => 1)).toBe('null');
  });

  it('keeps an answer of exactly the limit in bytes', () => {
    const body = { success: true, data: 'abc' };
    const limit = Buffer.byteLength(transportStringify(body), 'utf8');
    const { answer } = toTransport(body, limit);
    expect(answer).toEqual(body);
    expect(toTransport(body, limit - 1).answer.data).toBeUndefined();
  });
});

describe('an answer over the limit loses its payload', () => {
  for (const field of ['data', 'channels', 'roles', 'panels', 'guilds']) {
    it(`drops ${field} even when it is a string`, () => {
      const { answer, text } = toTransport({ success: true, [field]: 'z'.repeat(400), message: 'kept' }, 100);
      expect(field in answer).toBe(false);
      expect(text).not.toContain('zzz');
      expect(answer).toEqual({ success: true, message: 'kept', oversize: { bytes: expect.any(Number), reason: 'too-large' } });
    });
  }

  it('keeps finite numbers and booleans, drops non-finite numbers', () => {
    const { answer } = toTransport({ success: true, count: 5, ratio: 0.5, flag: false, inf: Infinity, nan: NaN, data: 'z'.repeat(400) }, 100);
    expect(answer).toEqual({ success: true, count: 5, ratio: 0.5, flag: false, oversize: { bytes: expect.any(Number), reason: 'too-large' } });
    expect('inf' in answer).toBe(false);
    expect('nan' in answer).toBe(false);
  });

  it('answers success false when the answer named no success', () => {
    const { answer, text } = toTransport({ data: 'z'.repeat(400) }, 100);
    expect(answer.success).toBe(false);
    expect(JSON.parse(text).success).toBe(false);
  });

  it('keeps only the drop record when the answer keys cannot be read', () => {
    const source = new Proxy({}, {
      ownKeys() { throw new Error('no keys'); },
      get(_t, key) { return typeof key === 'string' ? 'v' : undefined; },
    });
    const { answer } = toTransport(source);
    expect(answer).toEqual({ oversize: { bytes: 0, reason: 'not-serializable' }, success: false });
  });
});

describe('a missing answer', () => {
  const none = { success: false, error: 'The bot gave no answer.' };
  for (const [name, value] of [['null', null], ['undefined', undefined], ['a string', 'hello'], ['a number', 42], ['false', false]] as const) {
    it(`answers that the bot gave no answer for ${name}`, () => {
      const { answer, text } = toTransport(value);
      expect(answer).toEqual(none);
      expect(JSON.parse(text)).toEqual(none);
    });
  }
});
