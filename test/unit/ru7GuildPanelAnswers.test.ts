import { describe, expect, it } from 'vitest';

import { localPanelAnswer, PANEL_TEXTS, remotePanelAnswer, type Outcome } from '../../src/webui/utils/guildRequests';

const SAVED_LOCAL = 'The panel action ran and its changes were saved, but the panel it returned cannot be shown here. Do not run it again; check the result in Discord.';
const PENDING_LOCAL = 'The panel action ran, and its changes are not confirmed as saved yet, but the panel it returned cannot be shown here. Do not run it again; check the result in Discord.';
const MEMBER_UNREACHABLE = 'The bot cannot be reached right now; nothing was run. Try again in a moment.';

describe('ru7 local panel oversize note', () => {
  it('says the changes were saved when no pending flag is given', () => {
    expect(PANEL_TEXTS.localPanelOversize()).toBe(SAVED_LOCAL);
  });

  it('a local panel action whose panel is too large answers 200 with the saved note and no data', () => {
    const answer = localPanelAnswer('panel:execute', { success: true, data: { big: 1 }, oversize: { bytes: 300000, reason: 'too-large' } });
    expect(answer.status).toBe(200);
    expect(answer.reply.success).toBe(true);
    expect(answer.reply.data).toBeNull();
    expect(answer.reply.note).toBe(SAVED_LOCAL);
  });

  it('a local pending panel action says its changes are not confirmed as saved', () => {
    const answer = localPanelAnswer('panel:button', { success: true, pending: true, oversize: { bytes: 300000, reason: 'too-large' } });
    expect(answer.reply.note).toBe(PENDING_LOCAL);
  });
});

describe('ru7 captured replies left out, local or member wording', () => {
  it('replies not kept after a retake name the count, with no machine name', () => {
    expect(PANEL_TEXTS.capturedOmitted(null, { reason: 'not-kept', count: 3 }))
      .toBe("The command's 3 captured replies were not kept after the request was taken again, and are left out.");
  });

  it('replies too large name the count and size, with no machine name', () => {
    expect(PANEL_TEXTS.capturedOmitted(null, { reason: 'too-large', count: 2, bytes: 2048 }))
      .toBe("The command's 2 captured replies (2 KiB) cannot be shown here and are left out.");
  });

  it('a local command answer with captured replies left out carries the note', () => {
    const answer = localPanelAnswer('command:invoke', { success: true, capturedOmitted: { count: 4, bytes: 4096 } });
    expect(answer.status).toBeNull();
    expect(answer.reply.note).toBe("The command's 4 captured replies (4 KiB) cannot be shown here and are left out.");
  });
});

describe('ru7 sizeAnswer by op', () => {
  it('a command answer marked oversize is passed through unchanged', () => {
    const reply = { success: true, data: 'kept', oversize: { bytes: 300000 } };
    const answer = localPanelAnswer('command:invoke', reply);
    expect(answer.status).toBeNull();
    expect(answer.reply).toEqual({ success: true, data: 'kept', oversize: { bytes: 300000 } });
    expect(answer.reply.note).toBeUndefined();
  });

  it('an oversize panel list answers 502 answer-too-large', () => {
    const answer = localPanelAnswer('panel:list', { success: true, panels: [], oversize: { bytes: 300000 } });
    expect(answer.status).toBe(502);
    expect(answer.reply).toEqual({ success: false, code: 'answer-too-large', error: 'The panel list of this server is too large to show here; nothing was changed.' });
  });

  it('an oversize server list answers 502 answer-too-large', () => {
    const answer = localPanelAnswer('guild:membership', { success: true, guilds: [], oversize: { bytes: 300000 } });
    expect(answer.status).toBe(502);
    expect(answer.reply.code).toBe('answer-too-large');
    expect(answer.reply.error).toBe('The server list of this server is too large to show here; nothing was changed.');
  });

  it('an oversize flag that is not an object is ignored', () => {
    const answer = localPanelAnswer('panel:execute', { success: true, data: 'panel', oversize: true });
    expect(answer.status).toBeNull();
    expect(answer.reply).toEqual({ success: true, data: 'panel', oversize: true });
  });

  it('captured replies on a panel action add no note', () => {
    const answer = localPanelAnswer('panel:execute', { success: true, data: 'panel', capturedOmitted: { count: 1, bytes: 10 } });
    expect(answer.status).toBeNull();
    expect(answer.reply.note).toBeUndefined();
    expect(answer.reply.data).toBe('panel');
  });

  it('a captured replies flag that is not an object adds no note to a command answer', () => {
    const answer = localPanelAnswer('command:invoke', { success: true, capturedOmitted: true });
    expect(answer.status).toBeNull();
    expect(answer.reply).toEqual({ success: true, capturedOmitted: true });
  });
});

describe('ru7 local answer that is not an object', () => {
  it('a string answer is a timeout with can not confirm', () => {
    const answer = localPanelAnswer('panel:execute', 'garbage');
    expect(answer.status).toBe(503);
    expect(answer.reply).toEqual({
      success: false,
      code: 'no-answer',
      noAnswer: 'timeout',
      error: "The bot did not answer in time; can't confirm whether the panel action ran. Check the server before you run it again.",
    });
  });

  it('a null answer is a timeout too', () => {
    const answer = localPanelAnswer('guild:roles', null);
    expect(answer.status).toBe(503);
    expect(answer.reply.error).toBe('The bot did not answer in time; nothing was changed. Try again in a moment.');
  });
});

const remote = (outcome: Outcome, audience: 'owner' | 'member', op: Parameters<typeof remotePanelAnswer>[0] = 'panel:execute') => remotePanelAnswer(op, outcome, audience, 'Node-B');

describe('ru7 remote refusals', () => {
  it('a failed read with no text says nothing was changed', () => {
    const answer = remote({ k: 'reply', reply: { success: false } }, 'member', 'guild:channels');
    expect(answer.reply.error).toBe('The bot could not answer the request; nothing was changed. Try again in a moment.');
  });

  it('an owner refusal at exit names the holder and says stopping', () => {
    const answer = remote({ k: 'exiting' }, 'owner');
    expect(answer.status).toBe(503);
    expect(answer.reply).toEqual({
      success: false,
      code: 'stopping',
      error: 'The web panel is shutting down; nothing was run. Run it again once it is back.',
      servedBy: 'Node-B',
    });
  });

  it('an owner unreachable answer gives the cause', () => {
    const answer = remote({ k: 'unreachable', cause: 'connection refused' }, 'owner');
    expect(answer.reply).toEqual({
      success: false,
      code: 'backend-unavailable',
      error: "Can't reach the database to send the panel action to Node-B (connection refused); nothing was run. Try again in a moment.",
      servedBy: 'Node-B',
    });
  });

  it('owner no-table answers backend-unavailable', () => {
    const answer = remote({ k: 'no-table' }, 'owner');
    expect(answer.reply.code).toBe('backend-unavailable');
    expect(answer.reply.servedBy).toBe('Node-B');
  });

  const memberCases: Array<[string, Outcome]> = [
    ['unreachable', { k: 'unreachable', cause: 'timeout' }],
    ['too-slow', { k: 'too-slow' }],
    ['no-table', { k: 'no-table' }],
    ['insert-refused', { k: 'insert-refused', code: '42501', message: 'denied' }],
    ['withdrawn', { k: 'withdrawn' }],
  ];
  for (const [name, outcome] of memberCases) {
    it(`member ${name} answers backend-unavailable with the member text`, () => {
      const answer = remote(outcome, 'member');
      expect(answer.status).toBe(503);
      expect(answer.reply).toEqual({ success: false, code: 'backend-unavailable', error: MEMBER_UNREACHABLE });
    });
  }

  it('owner withdrawn at exit says the request was withdrawn before the holder took it', () => {
    const answer = remote({ k: 'withdrawn-at-exit' }, 'owner');
    expect(answer.status).toBe(503);
    expect(answer.reply).toEqual({
      success: false,
      code: 'not-taken',
      error: 'This web panel is shutting down, so the panel action sent to Node-B was withdrawn before Node-B took it; nothing was run. Run it again once the panel is back.',
      servedBy: 'Node-B',
    });
  });

  it('member withdrawn at exit answers not-taken with the shutdown text', () => {
    const answer = remote({ k: 'withdrawn-at-exit' }, 'member');
    expect(answer.reply).toEqual({ success: false, code: 'not-taken', error: 'The web panel is shutting down; nothing was run. Run it again once it is back.' });
  });
});

describe('ru7 remote unapplied answers', () => {
  it('a not-taken reply without unapplied is not worded as unapplied', () => {
    const answer = remote({ k: 'reply', reply: { success: false, code: 'not-taken', unapplied: false, error: 'Own text.' } }, 'member');
    expect(answer.status).toBeNull();
    expect(answer.reply.error).toBe('Own text.');
  });

  it('an unapplied flag on a successful reply with another code keeps the success', () => {
    const answer = remote({ k: 'reply', reply: { success: true, unapplied: true, data: 'x' } }, 'member');
    expect(answer.status).toBeNull();
    expect(answer.reply).toEqual({ success: true, unapplied: true, data: 'x' });
  });

  it('a not-taken unapplied reply says the holder could not start it', () => {
    const answer = remote({ k: 'reply', reply: { success: false, code: 'not-taken', unapplied: true } }, 'owner');
    expect(answer.status).toBe(503);
    expect(answer.reply.error).toBe('Node-B took the panel action but could not start it; nothing was run. Try again in a moment.');
  });
});
