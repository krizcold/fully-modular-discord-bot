import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { hashNonce, noticeEmbed } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { OwnerChannelValue, ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { BOT, DM, FakeOwnerRest, discordError, httpError } from '../helpers/fakeOwnerRest';

const TOKEN = 'sa15-switch-token';
const A = 'postgres://bot:pw@a.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
const OTHER_CHANNEL = '600000000000000015';
let rest: FakeOwnerRest;
let router: Router;
let answers: ProbeAnswer[] = [];

function main(generation: number, machine: string, ownerChannel: OwnerChannelValue): ProbeAnswer {
  const [e] = parseAddressList(A);
  return {
    kind: 'answered', address: e.shown, entry: A, inRecovery: false, readOnly: false, generation, machine, since: DATE,
    sysid: 'sys-a', started: 'start-a', storeId: 'store-1', ownerChannel,
  } as ProbeAnswer;
}

const noticeMessage = (generation: number, machine: string, also?: string[]) => ({ embeds: [noticeEmbed({ machine, generation, date: DATE }, also)] });
const answered = (id: string, generation: number, machine: string, also?: string[], channel = DM) =>
  ({ id, channel_id: channel, author: { id: BOT }, timestamp: DATE, ...noticeMessage(generation, machine, also) });
const call = { machine: 'M', generation: 2, date: DATE };
const dmMessages = new RegExp(`^/channels/${DM}/messages$`);
const dmPins = new RegExp(`^/channels/${DM}/messages/pins$`);
const anyPin = /^\/channels\/\d+\/messages\/pins\/\w+$/;
const ownNonce = hashNonce(JSON.stringify(['main', 2, 'M']));
const NOT_POSTED = 'The notice for M was not posted (Discord returned another message instead)';
const OTHER_ANSWERED = (other: string) => `Discord answered with the notice of ${other} instead of posting one for M`;

function invoke(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const req: any = { method: 'POST', url: path, headers: { 'x-bot-token': TOKEN }, body };
    const res: any = {
      status(code: number) { status = code; return res; },
      json(answer: unknown) { resolve({ status, body: answer }); return res; },
    };
    (router as any)(req, res, (error?: unknown) => reject(error ?? new Error(`no route answered ${path}`)));
  });
}

const post = () => invoke('/switch-notice', call);
const puts = () => rest.calls.filter(c => c.method === 'put' && anyPin.test(c.route));
const pinnedInDm = () => rest.pinned.get(DM) ?? new Set<string>();

/** The tie create in the DM answers the given message, as Discord may answer another message for a nonce. */
function tieAnswers(message: unknown): void {
  rest.on('post', dmMessages, () => message);
}

beforeEach(() => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  router = createManagedRoutes({} as BotManager);
  rest = new FakeOwnerRest(300);
  _setManagedTiming({ notifyMs: 600, switchMs: 900 });
  _resetOwnerChannel();
  _resetWebuiChoice();
  answers = [main(2, 'M', { kind: 'none' })];
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(A),
    probe: async () => answers,
    readNotice: async () => ({ kind: 'none' }),
    markerStoreId: () => 'store-1',
    noticeCheckOff: () => false,
  });
  setBackendKind('postgres');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  FakeOwnerRest.reset();
  _setManagedTiming(null);
  _setWebuiChoiceDeps(null);
  setBackendKind(null);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.restoreAllMocks();
});

describe('sa15: what Discord answers to the tie notice decides what the answer claims', () => {
  it('a tie notice of this machine answered in another channel is not taken as posted', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    tieAnswers(answered('far1', 2, 'M', ['O'], OTHER_CHANNEL));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, posted: false, present: false, pinned: false });
    expect(res.body.error).toContain(NOT_POSTED);
    expect(puts()).toHaveLength(0);
  });

  it('a tie notice of this machine at another generation is not taken as the tie notice of generation 2', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    tieAnswers(answered('old1', 1, 'M', ['O']));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, posted: false, present: false, pinned: false });
    expect(res.body.error).toContain(NOT_POSTED);
    expect(puts()).toHaveLength(0);
  });

  it('a tie notice of another machine at generation 2 is reported as that machine\'s notice, not as this one posted', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    tieAnswers(answered('x1', 2, 'X', ['O']));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, posted: false, present: false, pinned: false });
    expect(res.body.tie).toEqual({ generation: 2, machines: ['M', 'O', 'X'], named: ['O', 'X'] });
    expect(res.body.error).toContain(`${OTHER_ANSWERED('X')}.`);
  });

  it('an ordinary notice of another machine at generation 2 is named and is not taken as this machine\'s notice', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    tieAnswers(answered('x2', 2, 'X'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, posted: false, present: false, pinned: false });
    expect(res.body.tie).toEqual({ generation: 2, machines: ['M', 'O', 'X'], named: ['O', 'X'] });
    expect(res.body.error).toBe(
      `M, O and X announced main generation 2; can't confirm which is the main. ${OTHER_ANSWERED('X')}. `
      + "The bot stops on every machine that reads the switch notices, until the owner presses Keep this machine as the main in one machine's Bot Manager",
    );
    expect(puts()).toHaveLength(0);
  });

  it('a notice of another generation adds none of its machines to the tie', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    tieAnswers(answered('z1', 1, 'Z'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.tie).toEqual({ generation: 2, machines: ['M', 'O'], named: ['O'] });
    expect(res.body.error).toContain(`${NOT_POSTED}, so the bot on O may still be writing.`);
  });

  it('a notice of another machine at another generation is not reported as that machine\'s notice of generation 2', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    tieAnswers(answered('x3', 1, 'X'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.tie).toEqual({ generation: 2, machines: ['M', 'O'], named: ['O'] });
    expect(res.body.error).toContain(NOT_POSTED);
    expect(res.body.error).not.toContain('Discord answered with the notice of');
  });

  it('an ordinary notice of this machine at another generation does not stand for its notice of generation 2', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    tieAnswers(answered('old2', 1, 'M'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, posted: false, present: false, pinned: false });
    expect(res.body.error).toContain(NOT_POSTED);
    expect(puts()).toHaveLength(0);
  });

  it('an ordinary notice of this machine at generation 2 answered for the tie is pinned, and a failed pin says so', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    tieAnswers(answered('ret2', 2, 'M'));
    rest.fail('put', anyPin, discordError(403, 50013, 'Missing Permissions'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, posted: false, present: true, pinned: false });
    expect(puts().map(c => c.route)).toEqual([`/channels/${DM}/messages/pins/ret2`]);
    expect(res.body.note).toContain("The notice for M is in the owner's DMs but not pinned (HTTP 403 (Missing Permissions))");
  });

  it('a pinned notice of this machine found in the DM stays the one counted when Discord answers another copy of it', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.seed(DM, noticeMessage(2, 'M'), true);
    tieAnswers(answered('ret3', 2, 'M'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, posted: false, present: true, pinned: true });
    expect(puts()).toHaveLength(0);
    expect(pinnedInDm().has('ret3')).toBe(false);
  });
});

describe('sa15: pins in the tie step', () => {
  it('a notice of this machine found unpinned, whose pin fails, is reported as already in the DM, not as posted', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    const own = rest.seed(DM, noticeMessage(2, 'M'));
    rest.fail('post', dmMessages, discordError(403, 50007, 'Cannot send messages to this user'));
    rest.fail('put', anyPin, discordError(403, 50013, 'Missing Permissions'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, posted: false, present: true, pinned: false });
    expect(puts().map(c => c.route)).toEqual([`/channels/${DM}/messages/pins/${own.id}`]);
    expect(res.body.note).toContain("The notice for M is in the owner's DMs but not pinned (HTTP 403 (Missing Permissions))");
    expect(res.body.note).not.toContain('Posted, but not pinned');
  });

  it('a tie notice already pinned is not pinned again and the answer says pinned', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.seed(DM, noticeMessage(2, 'M', ['O']), true);
    rest.fail('put', anyPin, discordError(403, 50013, 'Missing Permissions'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, posted: false, present: true, pinned: true, channel: 'none' });
    expect(puts()).toHaveLength(0);
    expect(rest.creates(DM)).toHaveLength(0);
    expect(res.body.note ?? '').not.toContain('not pinned');
  });

  it('pinning the tie notice unpins only notices of older generations: the other machine\'s notice of generation 2 stays pinned', async () => {
    const older = rest.seed(DM, noticeMessage(1, 'Z'), true);
    const other = rest.seed(DM, noticeMessage(2, 'O'), true);
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: true, present: true, pinned: true });
    const tie = rest.creates(DM);
    expect(tie).toHaveLength(1);
    const tieMessage = (rest.messages.get(DM) ?? []).find(m => m.nonce === hashNonce(JSON.stringify(['main', 2, 'M', 'tie'])));
    expect(tieMessage).toBeDefined();
    const pins = pinnedInDm();
    expect(pins.has(tieMessage.id)).toBe(true);
    expect(pins.has(other.id)).toBe(true);
    expect(pins.has(older.id)).toBe(false);
  });
});

describe('sa15: the notice posted with no tie', () => {
  it('pinning the posted notice unpins only older generations: a notice of generation 2 pinned meanwhile stays pinned', async () => {
    const older = rest.seed(DM, noticeMessage(1, 'Z'), true);
    let pinReads = 0;
    rest.on('get', dmPins, () => {
      if (++pinReads > 1) {
        for (const m of rest.messages.get(DM) ?? []) if (m.nonce === ownNonce) pinnedInDm().add(m.id);
      }
      return undefined;
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, posted: true, pinned: true });
    expect(pinReads).toBe(2);
    const own = (rest.messages.get(DM) ?? []).find(m => m.nonce === ownNonce);
    expect(own).toBeDefined();
    expect(pinnedInDm().has(own.id)).toBe(true);
    expect(pinnedInDm().has(older.id)).toBe(false);
  });

  it('a notice of another machine at another generation answered for the post is refused, not reported as a tie', async () => {
    tieAnswers(answered('x4', 1, 'X'));
    const res = await post();
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Discord refused the switch notice to the bot\'s owner (Discord returned another message instead)');
    expect(res.body.tie).toBeUndefined();
  });

  it('a notice of another machine answered while the DM could not be read names only the machines the answer shows', async () => {
    let pinReads = 0;
    rest.on('get', dmPins, () => {
      if (++pinReads === 1) throw httpError(500, 'Internal Server Error');
      return undefined;
    });
    tieAnswers(answered('x5', 2, 'X'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(pinReads).toBe(1);
    expect(res.body.tie).toEqual({ generation: 2, machines: ['M', 'X'], named: ['X'] });
    expect(res.body.error).toContain(`${OTHER_ANSWERED('X')}, so the bot on X may still be writing.`);
  });
});
