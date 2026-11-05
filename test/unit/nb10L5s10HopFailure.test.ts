import { describe, expect, it } from 'vitest';
import { hopFailure, noAnswerText, sharedOpFailure, webhookAnswer } from '../../src/webui/routes/hopFailure';

// NB10: the HTTP answer and operator text for each refusal the bot sends back over IPC, and a webhook's answer to the
// provider; a refusal never reads as saved, and an unanswered change says "can't confirm".

describe('hopFailure: each refusal code without a detail answers its own status and text', () => {
  const cases: Array<[string, number, string]> = [
    ['starting', 503, 'The bot is starting and has not opened its data files yet; nothing was saved. Try again in a moment.'],
    ['stopping', 503, 'The bot is stopping; nothing was saved. Save again once it has stopped.'],
    ['held-elsewhere', 503, 'Another process holds the data files; nothing was saved. Try again once it has ended.'],
    ['changed', 409, 'This file changed while the save was being made; nothing was saved. Reload it to see the current values.'],
    ['changed-since-open', 409, 'This file changed since you opened it; nothing was saved. Reload it to see the current values.'],
    ['disk', 503, 'The disk did not take the write, so your change was not saved. Check the disk, then try again.'],
    ['unconfirmed', 503, 'Your change is not confirmed as saved yet. Please check again in a moment.'],
    ['no-answer', 503, "The bot did not answer; can't confirm whether the change was saved. Reload to check."],
  ];
  for (const [code, status, error] of cases) {
    it(`${code} answers ${status} with its default text`, () => {
      expect(hopFailure(code)).toEqual({ status, error });
    });
  }

  it('the empty code is not a known refusal', () => {
    expect(hopFailure('')).toBeNull();
  });
});

describe('noAnswerText: the lead names why the bot gave no answer', () => {
  it('an unknown cause leads with "The bot did not answer"', () => {
    expect(noAnswerText('other', 'write')).toBe("The bot did not answer; can't confirm whether the change was saved. Reload to check.");
  });
});

describe('sharedOpFailure: replies that are not ok', () => {
  it('a missing reply answers 500 "The change failed"', () => {
    expect(sharedOpFailure(null)).toEqual({ status: 500, error: 'The change failed' });
    expect(sharedOpFailure(undefined)).toEqual({ status: 500, error: 'The change failed' });
  });

  it('a non-string error is not used as the operator text', () => {
    expect(sharedOpFailure({ code: 'invalid', error: 42 })).toEqual({ status: 400, error: 'Invalid request' });
    expect(sharedOpFailure({ code: 'other', error: { x: 1 } })).toEqual({ status: 500, error: 'The change failed' });
  });

  it('invalid answers 400 with the detail or "Invalid request"', () => {
    expect(sharedOpFailure({ code: 'invalid' })).toEqual({ status: 400, error: 'Invalid request' });
    expect(sharedOpFailure({ code: 'invalid', error: 'bad field' })).toEqual({ status: 400, error: 'bad field' });
  });

  it('an unknown code answers 500, not 400', () => {
    expect(sharedOpFailure({ code: 'weird' })).toEqual({ status: 500, error: 'The change failed' });
    expect(sharedOpFailure({ code: 'weird', error: 'it broke' })).toEqual({ status: 500, error: 'it broke' });
  });
});

describe('webhookAnswer: the answer to the payment provider', () => {
  it('a missing reply answers 503 so the provider delivers it again', () => {
    expect(webhookAnswer(null)).toEqual({ status: 503, body: { error: 'The change failed' }, log: 'not applied: The change failed' });
  });

  it('an unknown provider answers 404 with the error in the body', () => {
    const error = 'Unknown provider or no webhook handler: acme';
    expect(webhookAnswer({ code: 'invalid', error })).toEqual({ status: 404, body: { error } });
  });

  it('the unknown-provider text under another code is not a 404', () => {
    const error = 'Unknown provider or no webhook handler: acme';
    expect(webhookAnswer({ code: 'disk', error })).toEqual({ status: 503, body: { error }, log: `not applied: ${error}` });
  });

  it("the handler's own error answers 400 with that error and logs it", () => {
    expect(webhookAnswer({ code: 'invalid', error: 'signature mismatch' })).toEqual({
      status: 400,
      body: { error: 'signature mismatch' },
      log: 'failed: signature mismatch',
    });
  });

  it('an invalid reply without an error answers 400 "Webhook handling failed"', () => {
    expect(webhookAnswer({ code: 'invalid' })).toEqual({
      status: 400,
      body: { error: 'Webhook handling failed' },
      log: 'failed: undefined',
    });
  });

  it('a refusal answers 503 and logs the refusal text', () => {
    expect(webhookAnswer({ code: 'frozen' })).toEqual({
      status: 503,
      body: { error: "This guild's shard is not served by this bot process right now, so nothing was changed; retry in a moment" },
      log: "not applied: This guild's shard is not served by this bot process right now, so nothing was changed; retry in a moment",
    });
  });
});
