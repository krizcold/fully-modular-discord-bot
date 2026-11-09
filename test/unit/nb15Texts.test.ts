import { describe, expect, it, vi } from 'vitest';

// NB15 test 5, the render matrix (decision 12, decision 7's ranTruthText, gatekeeper rulings 3 and 9): every text for
// each op and both audiences. ASCII, no long dash; "On <name>: " only for the owner; can't confirm exactly where the
// outcome is unknown; no text for an outcome that ran invites a new run.
const stopping = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return { ...real, isStopping: () => stopping.on };
});

import { operatorRefusalText, ranTruthText, TRUTH_ANSWERS } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { PANEL_REQUEST_OPS, isReadOp, type PanelRequestOp } from '../../src/bot/internalSetup/utils/panelRequestShape';
import { NB7_TEXTS, OP_WORDS, PANEL_TEXTS, localPanelAnswer, remotePanelAnswer, type Outcome } from '../../src/webui/utils/guildRequests';
import { LIVE_REASONS, outOfDateLine } from '../../src/webui/utils/panelLiveWatch';

const NAME = 'BRAVO';
const ASCII = /^[\x20-\x7e]*$/;
const RAN_OUTCOMES: Outcome[] = [{ k: 'no-answer', cause: 'timeout' }, { k: 'no-answer', cause: 'lost' }, { k: 'no-answer', cause: 'unsettled' }, { k: 'no-answer', cause: 'stopped' }];
const NOTHING_OUTCOMES: Outcome[] = [
  { k: 'maintenance' }, { k: 'exiting' }, { k: 'unreachable', cause: 'ECONNRESET' }, { k: 'too-slow' }, { k: 'no-table' },
  { k: 'insert-refused', code: '23514', message: 'check' }, { k: 'insecure' }, { k: 'not-taken' }, { k: 'withdrawn' }, { k: 'withdrawn-at-exit' },
  { k: 'reply', reply: { success: false, code: 'not-held', error: 'x' } },
  { k: 'reply', reply: { ok: false, code: 'not-taken', unapplied: true } },
  { k: 'reply', reply: { success: false, ran: false, code: 'invalid', error: 'The request for this server was malformed (the panel id is not valid); nothing was run.' } },
  { k: 'reply', reply: { success: false, ran: false, code: 'not-allowed', error: 'This panel runs only from the web panel of its own machine; nothing was run.' } },
  { k: 'reply', reply: { success: false, ran: false, code: 'member-panel-off', error: 'The member web panel is turned off for the machine that runs this server; nothing was run.' } },
  { k: 'reply', reply: { success: false, ran: false, code: 'not-ready', error: 'This server is not ready on the bot that runs it yet; nothing was run. Try again in a moment.' } },
];

const textOf = (op: PanelRequestOp, outcome: Outcome, audience: 'owner' | 'member') => String(remotePanelAnswer(op, outcome, audience, NAME).reply.error ?? remotePanelAnswer(op, outcome, audience, NAME).reply.note ?? '');

describe('the request route texts', () => {
  it.each(PANEL_REQUEST_OPS.map(op => [op]))('%s: ASCII, no long dash, a member text names no machine', op => {
    for (const outcome of [...RAN_OUTCOMES, ...NOTHING_OUTCOMES]) {
      for (const audience of ['owner', 'member'] as const) {
        const text = textOf(op, outcome, audience);
        expect(text, `${op} ${outcome.k} ${audience}`).toMatch(ASCII);
        expect(text).not.toMatch(/[\u2013\u2014]/);
        expect(text.length).toBeGreaterThan(0);
        if (audience === 'member') expect(text, `${op} ${outcome.k}`).not.toContain(NAME);
      }
    }
  });

  it.each(PANEL_REQUEST_OPS.filter(op => !isReadOp(op)).map(op => [op]))("%s: can't confirm for every unknown outcome, never 'try again', and the check-the-server ending", op => {
    for (const outcome of RAN_OUTCOMES) {
      for (const audience of ['owner', 'member'] as const) {
        const text = textOf(op, outcome, audience);
        expect(text).toContain("can't confirm");
        expect(text).not.toMatch(/[Tt]ry again/);
        expect(text).not.toContain('nothing was run');
        expect(text.endsWith('Check the server before you run it again.')).toBe(true);
      }
    }
  });

  it('a read that did not answer says nothing was changed', () => {
    for (const op of PANEL_REQUEST_OPS.filter(isReadOp)) {
      expect(textOf(op, { k: 'no-answer', cause: 'timeout' }, 'owner')).toMatch(/^BRAVO did not send the .+ in time; nothing was changed\. Try again in a moment\.$/);
      expect(textOf(op, { k: 'no-answer', cause: 'timeout' }, 'member')).toMatch(/^The bot did not send the .+ in time; nothing was changed\. Try again in a moment\.$/);
    }
  });

  it('every refusal before anything ran says nothing was run (or read), with no can\'t confirm', () => {
    for (const op of PANEL_REQUEST_OPS) {
      for (const outcome of NOTHING_OUTCOMES) {
        for (const audience of ['owner', 'member'] as const) {
          const text = textOf(op, outcome, audience);
          expect(text, `${op} ${outcome.k} ${audience}`).not.toContain("can't confirm");
          if (outcome.k !== 'maintenance') expect(text, `${op} ${outcome.k} ${audience}`).toMatch(/[Nn]othing was (run|read)/);
        }
      }
    }
  });

  it('a holder failure carries "On <name>: " for the owner, never for the member', () => {
    const outcome: Outcome = { k: 'reply', reply: { success: false, ran: true, truth: 'deposed', error: ranTruthText({ answer: 'deposed', partial: false }) } };
    expect(textOf('panel:button', outcome, 'owner')).toBe(`On BRAVO: the action ran, but another bot process took over this server's data, so its changes were not saved. Check the server before you run it again.`);
    expect(textOf('panel:button', outcome, 'member')).toBe("The action ran, but another bot process took over this server's data, so its changes were not saved. Check the server before you run it again.");
  });

  it("the holder's own text keeps its case after 'On <name>: '; only the fragments the sheet words are lowercased", () => {
    const rate = textOf('panel:button', { k: 'reply', reply: { success: false, error: 'Rate limit exceeded. Please wait before trying again.' } }, 'owner');
    expect(rate).toBe('On BRAVO: Rate limit exceeded. Please wait before trying again.');
    expect(rate).toContain('Rate limit');
    expect(textOf('panel:button', { k: 'reply', reply: { success: false, error: 'Data file not found: settings.json' } }, 'owner')).toBe('On BRAVO: Data file not found: settings.json');
    expect(textOf('panel:button', NOTHING_OUTCOMES[15], 'owner')).toBe('On BRAVO: this server is not ready on the bot that runs it yet; nothing was run. Try again in a moment.');
    expect(textOf('panel:button', NOTHING_OUTCOMES[12], 'owner')).toBe('On BRAVO: the request for this server was malformed (the panel id is not valid); nothing was run.');
    expect(textOf('panel:button', NOTHING_OUTCOMES[13], 'owner')).toBe('On BRAVO: this panel runs only from the web panel of its own machine; nothing was run.');
    expect(textOf('command:invoke', { k: 'reply', reply: { success: false, ran: false, code: 'not-allowed', error: '/webui is a developer command and runs only from the console of its own machine; nothing was run.' } }, 'owner'))
      .toBe('On BRAVO: /webui is a developer command and runs only from the console of its own machine; nothing was run.');
    expect(textOf('panel:button', { k: 'reply', reply: { success: false, error: 'Rate limit exceeded. Please wait before trying again.' } }, 'member')).toBe('Rate limit exceeded. Please wait before trying again.');
  });

  it('a kept answer of a re-claimed action keeps its error text (NB15-L1)', () => {
    const first = { success: false, ran: true, truth: 'deposed', partial: false, error: ranTruthText({ answer: 'deposed', partial: false }), oversize: { bytes: 0, reason: 'not-kept' } };
    const text = textOf('panel:button', { k: 'reply', reply: first }, 'owner');
    expect(text).toBe(`On BRAVO: ${first.error.charAt(0).toLowerCase()}${first.error.slice(1)}`);
    expect(text).not.toMatch(/refused the request/i);
  });

  it("decision 12's statuses and codes", () => {
    expect(remotePanelAnswer('panel:execute', { k: 'not-taken' }, 'owner', NAME)).toMatchObject({ status: 503, reply: { code: 'not-taken', error: 'BRAVO did not take the panel action within 5 s; nothing was run. Try again in a moment; if it keeps happening, look for [GuildRequests] lines in the bot log on BRAVO.' } });
    expect(remotePanelAnswer('panel:execute', { k: 'reply', reply: { ok: false, code: 'not-taken', unapplied: true } }, 'owner', NAME).reply.error).toBe('BRAVO took the panel action but could not start it; nothing was run. Try again in a moment.');
    expect(remotePanelAnswer('panel:execute', { k: 'reply', reply: { ok: false, code: 'not-taken', unapplied: true } }, 'member', NAME).reply.error).toBe('The bot could not start the panel action; nothing was run. Try again in a moment.');
    expect(remotePanelAnswer('panel:execute', { k: 'reply', reply: { success: false, code: 'not-held' } }, 'owner', NAME)).toMatchObject({ status: 503, reply: { code: 'not-taken', error: 'On BRAVO: the bot stopped serving this server before it ran the panel action; nothing was run. Try again in a moment.' } });
    expect(remotePanelAnswer('panel:execute', NOTHING_OUTCOMES[12], 'owner', NAME).status).toBe(400);
    expect(remotePanelAnswer('panel:execute', NOTHING_OUTCOMES[13], 'member', NAME)).toMatchObject({ status: 403, reply: { error: 'This panel cannot be used from here; nothing was run.' } });
    expect(remotePanelAnswer('panel:execute', NOTHING_OUTCOMES[14], 'member', NAME).status).toBe(403);
    expect(remotePanelAnswer('panel:execute', NOTHING_OUTCOMES[15], 'owner', NAME)).toMatchObject({ status: 503, reply: { code: 'not-ready' } });
    expect(remotePanelAnswer('guild:channels', { k: 'reply', reply: { success: false, oversize: { bytes: 300 * 1024, reason: 'too-large' } } }, 'owner', NAME)).toMatchObject({ status: 502, reply: { code: 'answer-too-large', error: 'On BRAVO: the channel list is 300 KiB, more than the 256 KiB one machine sends to another; open this panel from the web panel on BRAVO.' } });
    expect(remotePanelAnswer('guild:roles', { k: 'reply', reply: { success: false, oversize: { bytes: 300 * 1024, reason: 'too-large' } } }, 'member', NAME).reply.error).toBe('The role list of this server is too large to show here; nothing was changed.');
  });

  it('a panel that ran and saved but cannot be shown is 200 with a note, never a failure', () => {
    const owner = remotePanelAnswer('panel:button', { k: 'reply', reply: { success: true, oversize: { bytes: 300 * 1024, reason: 'too-large' } } }, 'owner', NAME);
    expect(owner).toMatchObject({ status: 200, reply: { success: true, data: null, servedBy: NAME } });
    expect(owner.reply.note).toBe('On BRAVO: the panel action ran and its changes were saved; the panel it returned is 300 KiB, too large to show here. Open the panel from the web panel on BRAVO.');
    const member = remotePanelAnswer('panel:button', { k: 'reply', reply: { success: true, oversize: { bytes: 0, reason: 'not-serializable' } } }, 'member', NAME);
    expect(member.reply.note).toBe('The panel action ran and its changes were saved, but its result cannot be shown here. Do not run it again; check the result in Discord.');
    const invoke = remotePanelAnswer('command:invoke', { k: 'reply', reply: { success: true, capturedOmitted: { count: 3, bytes: 300 * 1024, reason: 'too-large' } } }, 'owner', NAME);
    expect(invoke.reply.note).toBe("On BRAVO: the command's 3 captured replies (300 KiB) are more than the 256 KiB one machine sends to another and are left out.");
    expect(invoke.reply.note, 'TX1: a command that ran is never asked to run again').not.toMatch(/run it|again/i);
  });

  it('"503" and "not running" appear only in texts that mean this machine\'s bot is not running', () => {
    for (const op of PANEL_REQUEST_OPS) {
      for (const outcome of [...RAN_OUTCOMES, ...NOTHING_OUTCOMES]) {
        for (const audience of ['owner', 'member'] as const) {
          const text = textOf(op, outcome, audience);
          expect(text).not.toContain('503');
          expect(text).not.toContain('not running');
        }
      }
    }
  });
});

describe('the local route texts (decision 12)', () => {
  it('a local timeout and a stopped child answer 503 no-answer, never 500', () => {
    expect(localPanelAnswer('panel:execute', { success: false, error: 'IPC request timed out', noAnswer: 'timeout' })).toEqual({ status: 503, reply: { success: false, code: 'no-answer', noAnswer: 'timeout', error: "The bot did not answer in time; can't confirm whether the panel action ran. Check the server before you run it again." } });
    expect(localPanelAnswer('command:invoke', { success: false, noAnswer: 'stopped' }).reply.error).toBe("The bot stopped before it answered; can't confirm whether the command ran. Check the server before you run it again.");
    expect(localPanelAnswer('guild:roles', { success: false, noAnswer: 'timeout' }).reply.error).toBe('The bot did not answer in time; nothing was changed. Try again in a moment.');
    expect(localPanelAnswer('panel:execute', { success: false, code: 'not-ready', error: 'x' }).status).toBe(503);
  });
});

describe('ranTruthText (ruling 3)', () => {
  it.each(TRUTH_ANSWERS.map(a => [a]))('%s: says the action ran, never try again, ends with the check', answer => {
    for (const partial of [false, true]) {
      for (const changed of [undefined, 'deleted' as const, { machine: 'CHARLIE', at: new Date(0) }]) {
        for (const stop of [false, true]) {
          stopping.on = stop;
          const verdict = { answer, partial, changed, refused: [{ doc: 'g/m/a.json', answer: 'unstorable' as const, reason: 'it holds U+0000' }], accepted: 'none' as const };
          const text = ranTruthText(verdict);
          expect(text.startsWith('The action ran, but ')).toBe(true);
          expect(text.endsWith(' Check the server before you run it again.')).toBe(true);
          expect(text).not.toMatch(/[Tt]ry again|Reload/);
          expect(text).toMatch(ASCII);
          expect((text.match(/run it again/g) ?? []).length).toBe(1);
        }
      }
    }
    stopping.on = false;
  });

  it('unstorable carries operatorRefusalText(verdict) with its document and reason', () => {
    const verdict = { answer: 'unstorable' as const, partial: false, refused: [{ doc: 'g/m/a.json', answer: 'unstorable' as const, reason: 'it holds U+0000' }], accepted: 'none' as const };
    const own = operatorRefusalText(verdict);
    const text = ranTruthText(verdict);
    expect(text).toBe(`The action ran, but ${own.charAt(0).toLowerCase()}${own.slice(1)} Check the server before you run it again.`);
    expect(text).toContain('g/m/a.json');
    expect(text).toContain('it holds U+0000');
  });

  it('changed-elsewhere names the machine and the time, or that the data was deleted', () => {
    const at = new Date(0);
    expect(ranTruthText({ answer: 'changed-elsewhere', partial: false, changed: { machine: 'CHARLIE', at } })).toContain('on CHARLIE at 1970-01-01T00:00:00.000Z');
    expect(ranTruthText({ answer: 'changed-elsewhere', partial: true, changed: 'deleted' })).toContain('was deleted');
    expect(ranTruthText({ answer: 'changed-elsewhere', partial: true, changed: 'deleted' })).toContain('were not saved in full');
  });

  it('the deposed text as decision 7 names it', () => {
    expect(ranTruthText({ answer: 'deposed', partial: false })).toBe("The action ran, but another bot process took over this server's data, so its changes were not saved. Check the server before you run it again.");
  });
});

describe("NB7's insecure-transport text and the live line", () => {
  it.each(Object.values(OP_WORDS).map(w => [w]))('NB7 op word %s', saved => {
    expect(NB7_TEXTS.insecure(saved)).toBe(`This machine's database address does not check the database's certificate, so changes to servers other machines run are off; nothing was ${saved}. Set sslmode=verify-full with sslrootcert in DATA_BACKEND_URL.`);
  });

  it('the out-of-date line for each of its five reasons', () => {
    const reasons = [LIVE_REASONS.unreachable, LIVE_REASONS.insecure, LIVE_REASONS.tooMany, LIVE_REASONS.cannotAnnounce(NAME), LIVE_REASONS.notFetched];
    expect(reasons).toEqual([
      'the database cannot be reached',
      "this machine's database address does not check the database's certificate",
      'too many panels from other machines are open',
      'BRAVO cannot announce its changes right now',
      'the latest change could not be fetched',
    ]);
    for (const reason of reasons) {
      expect(outOfDateLine(NAME, reason)).toBe(`This panel may be out of date: changes made on BRAVO are not shown here by themselves right now (${reason}). It updates when you use it.`);
    }
  });

  it('the shutting-down and over-16-KiB texts', () => {
    expect(PANEL_TEXTS.shuttingDown('panel:execute')).toBe('The web panel is shutting down; nothing was run. Run it again once it is back.');
    expect(PANEL_TEXTS.shuttingDown('guild:roles')).toBe('The web panel is shutting down; nothing was read. Run it again once it is back.');
    expect(PANEL_TEXTS.tooLarge(17 * 1024)).toBe('This request is 17 KiB, more than the 16 KiB one machine sends to another; nothing was run.');
  });
});
