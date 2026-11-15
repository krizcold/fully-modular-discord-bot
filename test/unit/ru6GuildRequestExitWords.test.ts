import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGuildRequests,
  _setGuildRequestDeps,
  endGuildRequests,
  opPhrase,
  PANEL_TEXTS,
  panelExitWords,
  remoteReadDoc,
  sendGuildChange,
  type RequestDb,
} from '../../src/webui/utils/guildRequests';
import { REQUEST_POLL_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { pollShim } from '../helpers/nb15PollShim';
import { fakeBot, fakeTime, GUILD, heldRow, requestPlan, writeOf } from '../helpers/nb7Rig';
import { setBackendKind } from '../helpers/backendKind';

const poll = (state: string, over: Record<string, unknown> = {}) => ({ rows: [{ state, reply: null, pickup_over: false, answer_over: false, ...over }] });

let script: (sql: string) => unknown = () => undefined;
const shim = pollShim(() => script);

function answerOf(value: unknown): Promise<any> {
  if (value instanceof Error) return Promise.reject(value);
  if (value instanceof Promise) return value;
  return Promise.resolve(value ?? { rows: [], rowCount: 0 });
}

function install(readDoc: (...args: any[]) => Promise<string | null> = async () => null): void {
  _resetGuildRequests();
  _setGuildRequestDeps({
    holderOf: async () => ({ rows: [heldRow()] }),
    readDoc,
    currentUrl: () => 'postgres://current',
    requestDb: (): RequestDb => ({
      connect: async () => ({
        server: 'S1',
        query: (sql: string, values: unknown[]) => answerOf(shim(sql, values)),
        release: () => undefined,
      }),
      end: async () => undefined,
    }),
    nodeId: () => 'n-a',
    nodeName: () => 'ALPHA',
  });
  setBackendKind('postgres');
}

beforeEach(() => {
  script = () => undefined;
});
afterEach(() => {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function exitLineFor(reply: string): Promise<string[]> {
  fakeTime();
  install();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  let exited = false;
  script = sql => (sql === REQUEST_POLL_SQL ? (exited ? poll('done', { reply }) : poll('pending')) : undefined);
  const plan = await requestPlan('write');
  void sendGuildChange(fakeBot().bot, plan, writeOf()).catch(() => undefined);
  await vi.advanceTimersByTimeAsync(10);
  exited = true;
  const exit = endGuildRequests().catch(() => undefined);
  await vi.advanceTimersByTimeAsync(10);
  await exit;
  return log.mock.calls.map(c => String(c[0]));
}

const answered = (words: string) => `[Main] Exiting: BRAVO answered the write of server ${GUILD}: ${words}`;

describe('the exit log line words a data change holder answer by its stored reply', () => {
  it('an accepted answer still pending says it is not confirmed as saved', async () => {
    expect(await exitLineFor('{"ok":true,"pending":true}')).toContain(answered('accepted, not confirmed as saved yet'));
  });

  it('a refusal names its code', async () => {
    expect(await exitLineFor('{"ok":false,"code":"bad-request"}')).toContain(answered('a refusal with code bad-request'));
  });

  it('a refusal without a code says none', async () => {
    expect(await exitLineFor('{"ok":false}')).toContain(answered('a refusal with code none'));
  });

  it('a refusal whose code is not text says none', async () => {
    expect(await exitLineFor('{"ok":false,"code":7}')).toContain(answered('a refusal with code none'));
  });

  it('a stored reply of null is logged as a refusal with code none', async () => {
    expect(await exitLineFor('null')).toContain(answered('a refusal with code none'));
  });
});

describe('panelExitWords', () => {
  it('a reply of null on an action says it failed and can not confirm it ran', () => {
    expect(panelExitWords(null, 'panel:button')).toBe("failed; can't confirm whether it ran");
  });

  it('a reply of null on a read says failed', () => {
    expect(panelExitWords(null, 'guild:channels')).toBe('failed');
  });

  it('an error that is not text is left out', () => {
    expect(panelExitWords({ ran: true, error: 42 }, 'panel:button')).toBe('ran and failed');
    expect(panelExitWords({ error: 42 }, 'panel:button')).toBe("failed; can't confirm whether it ran");
  });

  it('a text error is named, whatever its words', () => {
    expect(panelExitWords({ ran: true, error: 'Stryker was here!' }, 'panel:button')).toBe('ran and failed: Stryker was here!');
    expect(panelExitWords({ error: 'boom' }, 'panel:button')).toBe("failed (boom); can't confirm whether it ran");
    expect(panelExitWords({ error: 'boom' }, 'guild:roles')).toBe('failed: boom');
  });

  it('a read refusal names its code', () => {
    expect(panelExitWords({ success: false, code: 'not-held' }, 'guild:channels')).toBe('a refusal with code not-held');
  });

  it('a ran action without truth or error says ran and failed', () => {
    expect(panelExitWords({ ran: true }, 'panel:execute')).toBe('ran and failed');
  });

  it('an action refusal with a code but no ran flag names its code', () => {
    expect(panelExitWords({ success: false, code: 'bad-panel' }, 'panel:execute')).toBe('a refusal with code bad-panel');
  });

  it('an action that did not run and has no code says code none', () => {
    expect(panelExitWords({ ran: false }, 'panel:execute')).toBe('a refusal with code none');
  });
});

describe('remoteReadDoc', () => {
  it('passes the caller bound under the step bound, and caps it at 5 s', async () => {
    const bounds: number[] = [];
    install(async (...args: any[]) => { bounds.push(args[3]); return 'doc'; });
    expect(await remoteReadDoc(GUILD, 'm', 'a.json', 3000)).toBe('doc');
    expect(await remoteReadDoc(GUILD, 'm', 'a.json', 60_000)).toBe('doc');
    expect(await remoteReadDoc(GUILD, 'm', 'a.json', 0)).toBe('doc');
    expect(bounds).toEqual([3000, 5000, 1]);
  });
});

describe('PANEL_TEXTS wording', () => {
  it('a modal is called the panel action', () => {
    expect(opPhrase('panel:modal')).toBe('the panel action');
  });

  it('stoppedServing without a machine name starts with The bot', () => {
    expect(PANEL_TEXTS.stoppedServing('panel:button', null)).toBe('The bot stopped serving this server before it ran the panel action; nothing was run. Try again in a moment.');
  });

  it('noAnswer without a machine name names each cause', () => {
    expect(PANEL_TEXTS.noAnswer('panel:button', 'lost', null)).toBe("The bot's answer could not be read from the database; can't confirm whether the panel action ran. Check the server before you run it again.");
    expect(PANEL_TEXTS.noAnswer('panel:button', 'unsettled', null)).toBe("The database could not show that the panel action was withdrawn before the bot took it; can't confirm whether the panel action ran. Check the server before you run it again.");
    expect(PANEL_TEXTS.noAnswer('panel:button', 'stopped', null)).toBe("This web panel shut down before it read the bot's answer; can't confirm whether the panel action ran. Check the server before you run it again.");
    expect(PANEL_TEXTS.noAnswer('panel:button', 'timeout', null)).toBe("The bot did not answer in time; can't confirm whether the panel action ran. Check the server before you run it again.");
  });

  it('panelOversize says the changes were saved unless told they are pending', () => {
    expect(PANEL_TEXTS.panelOversize('BRAVO', { reason: 'too-large', bytes: 2048 })).toBe('On BRAVO: the panel action ran and its changes were saved; the panel it returned is 2 KiB, too large to show here. Open the panel from the web panel on BRAVO.');
  });

  it('panelOversize without a reason says the panel cannot be passed between machines', () => {
    expect(PANEL_TEXTS.panelOversize('BRAVO', {}, false)).toBe('On BRAVO: the panel action ran and its changes were saved; the panel it returned cannot be passed between machines to show here. Open the panel from the web panel on BRAVO.');
  });
});
