import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as J from '../oracle/judge.mjs';
import { checks } from '../oracle/model';
import { canonical, classifyAnswer, hashOf, parseLog } from '../oracle/oracle.mjs';

// The checker against the model of a correct store (test/oracle/model.ts):
// silent on every history the model allows, and naming each injected fault.

describe('the checker', () => {
  for (const check of checks()) {
    it(check.name, () => check.run(J, 300));
  }
});

describe('answers, content and logs', () => {
  it('classifies the operator route answers', () => {
    expect(classifyAnswer(200, { success: true })).toEqual({ cls: 'ACKED', definite: true });
    expect(classifyAnswer(202, { success: true, pending: true })).toEqual({ cls: 'HELD', definite: true });
    expect(classifyAnswer(0, null)).toEqual({ cls: 'UNKNOWN', definite: false });
    expect(classifyAnswer(400, { success: false, error: 'Invalid guildId format' })).toEqual({ cls: 'REFUSED', definite: true });
    expect(classifyAnswer(503, { success: false, error: 'Guild data is frozen for a shard migration; retry after it completes' }).definite).toBe(true);
    expect(classifyAnswer(503, { success: false, error: 'the bot process is not running' }).definite).toBe(true);
    // The rate limiter answers before any route runs.
    expect(classifyAnswer(429, { error: 'Rate limit exceeded. Please wait a moment.' })).toEqual({ cls: 'REFUSED', definite: true });
    // Ownership moved or the database switched mid-write: it may have landed.
    expect(classifyAnswer(503, { success: false, error: 'guild temporarily unavailable' }).definite).toBe(false);
    expect(classifyAnswer(503, { success: false, error: 'this node switched databases while saving; whether the write was carried over is unknown, so reload the data to check' }).definite).toBe(false);
    expect(classifyAnswer(500, { success: false, error: 'IPC timeout' }).definite).toBe(false);
    // The app's error handler, oversize bodies included, is judged as possibly applied.
    expect(classifyAnswer(500, { error: 'An error occurred', message: 'request entity too large' }).definite).toBe(false);
    // A committed answer whose body was lost is not claimed as committed.
    expect(classifyAnswer(200, null)).toEqual({ cls: 'REFUSED', definite: false });
  });

  it('hashes content the same however it is indented or its keys ordered', () => {
    fc.assert(fc.property(fc.jsonValue(), value => {
      const stored = JSON.parse(JSON.stringify(value, null, 2));
      expect(hashOf(stored)).toBe(hashOf(value));
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const reversed = Object.fromEntries(Object.entries(value).reverse());
        expect(canonical(reversed)).toBe(canonical(value));
      }
    }));
  });

  it('drops a torn last line and refuses a torn middle line', () => {
    const lines = ['{"t":"start","run":"r1","guild":"123456789012","lanes":[{"name":"l0"}]}', '{"t":"send","id":1'];
    expect(parseLog(lines.join('\n'))).toHaveLength(1);
    expect(() => parseLog([lines[1], lines[0]].join('\n'))).toThrow(/line 1/);
  });
});
