import { describe, expect, it } from 'vitest';

import { classifyInvokeAnswer, classifyInvokeError } from '../../src/cli/commands';

describe('classifyInvokeAnswer', () => {
  it('counts a 300 answer as not ok', () => {
    expect(classifyInvokeAnswer(299, {})).toBe('ok');
    expect(classifyInvokeAnswer(300, {})).toBe('unconfirmed');
  });

  it('counts a 2xx with success false as not ok', () => {
    expect(classifyInvokeAnswer(200, { success: false })).toBe('unconfirmed');
    expect(classifyInvokeAnswer(200, { success: false, ran: false })).toBe('failed');
  });

  it('keeps a no-answer code unconfirmed even beside ran false', () => {
    expect(classifyInvokeAnswer(500, { success: false, code: 'no-answer', ran: false })).toBe('unconfirmed');
  });

  it('keeps a noAnswer field unconfirmed even beside ran false', () => {
    expect(classifyInvokeAnswer(500, { success: false, noAnswer: 'timeout', ran: false })).toBe('unconfirmed');
  });

  it('keeps a pending answer unconfirmed even beside ran false', () => {
    expect(classifyInvokeAnswer(500, { success: false, pending: true, ran: false })).toBe('unconfirmed');
  });

  it('counts ran false at a 500 as failed', () => {
    expect(classifyInvokeAnswer(500, { success: false, ran: false })).toBe('failed');
  });

  it('keeps a known truth without ran unconfirmed at a 500', () => {
    expect(classifyInvokeAnswer(500, { success: false, truth: 'done' })).toBe('unconfirmed');
  });

  it('keeps ran true without a truth unconfirmed, and ran true with a truth failed', () => {
    expect(classifyInvokeAnswer(500, { success: false, ran: true })).toBe('unconfirmed');
    expect(classifyInvokeAnswer(500, { success: false, ran: true, truth: 'done' })).toBe('failed');
  });

  it('counts a bare 400 as failed', () => {
    expect(classifyInvokeAnswer(400, {})).toBe('failed');
  });

  it('counts a bare 413 as failed', () => {
    expect(classifyInvokeAnswer(413, {})).toBe('failed');
  });

  it('counts a bare 429 as failed', () => {
    expect(classifyInvokeAnswer(429, {})).toBe('failed');
  });
});

describe('classifyInvokeError', () => {
  it('counts a refused connection as failed and another error as unconfirmed', () => {
    expect(classifyInvokeError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe('failed');
    expect(classifyInvokeError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe('unconfirmed');
  });

  it('counts a thrown undefined or null as unconfirmed without throwing', () => {
    expect(classifyInvokeError(undefined)).toBe('unconfirmed');
    expect(classifyInvokeError(null)).toBe('unconfirmed');
  });
});
