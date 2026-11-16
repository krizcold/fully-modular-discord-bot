import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { hashNonce, noticeEmbed } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel, ownerChannelState } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { OwnerChannelValue, ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { BOT, DM, FakeOwnerRest, discordError, httpError } from '../helpers/fakeOwnerRest';

const TOKEN = 'sa14-switch-token';
const C = '500000000000000014';
const C2 = '500000000000000015';
const A = 'postgres://bot:pw@a.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
const BUDGET = "the route's budget of 25 s ran out";
const SWITCH_MS = 900;
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

const inChannel = (id: string): OwnerChannelValue => ({ kind: 'id', id });
const noticeMessage = (generation: number, machine: string, also?: string[]) => ({ embeds: [noticeEmbed({ machine, generation, date: DATE }, also)] });
const call = (generation = 2) => ({ machine: 'M', generation, date: DATE });
const channelRead = (id: string) => new RegExp(`^/channels/${id}/messages$`);
const dmMessages = new RegExp(`^/channels/${DM}/messages$`);
const dmPins = new RegExp(`^/channels/${DM}/messages/pins$`);
const isTie = (body: any) => body?.embeds?.[0]?.fields?.some((f: any) => f.name === 'Also announced') === true;
const ownNonce = hashNonce(JSON.stringify(['main', 2, 'M']));
const tieNonce = hashNonce(JSON.stringify(['main', 2, 'M', 'tie']));
const copyNonce = (id: string) => hashNonce(JSON.stringify(['copy', id, 2, 'M']));
const copyTieNonce = (id: string, g = 2) => hashNonce(JSON.stringify(['copy', id, g, 'M', 'tie']));
const refusedDm = () => discordError(403, 50007, 'Cannot send messages to this user');

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

const post = (body: unknown) => invoke('/switch-notice', body);

beforeEach(() => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  router = createManagedRoutes({} as BotManager);
  rest = new FakeOwnerRest(300);
  _setManagedTiming({ notifyMs: 600, switchMs: SWITCH_MS });
  _resetOwnerChannel();
  _resetWebuiChoice();
  answers = [main(2, 'M', inChannel(C))];
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

/** The first call of a tie: O's notice of generation 2 is pinned in the DM, M's tie notice and its copy in C post. */
async function firstTieCopy(): Promise<void> {
  rest.seed(DM, noticeMessage(2, 'O'), true);
  const first = await post(call());
  expect(first.status).toBe(409);
  expect(first.body.channel).toBe('posted');
  expect(rest.creates(C)).toHaveLength(1);
  expect(rest.messages.get(C)?.[0].nonce).toBe(copyTieNonce(C));
}

describe('sa14: which notices already in the chosen channel stand for the copy', () => {
  it('a notice of a higher generation in the channel: no copy is posted, the copy answers already', async () => {
    rest.seed(C, noticeMessage(3, 'X'));
    const res = await post(call());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, posted: true, pinned: true, channel: 'already' });
    expect(rest.creates(C)).toHaveLength(0);
  });

  it('a notice of this machine at a lower generation in the channel: the copy of generation 2 is posted', async () => {
    rest.seed(C, noticeMessage(1, 'M'));
    const res = await post(call());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, posted: true, channel: 'posted' });
    expect(rest.creates(C)).toHaveLength(1);
    const copy = rest.messages.get(C)?.[0];
    expect(copy.nonce).toBe(copyNonce(C));
    expect(copy.embeds[0].fields).toEqual([{ name: 'Machine', value: 'M' }, { name: 'Generation', value: '2' }]);
  });

  it('an ordinary copy of this machine at the generation does not stand for the tie copy, which is posted', async () => {
    rest.seed(C, noticeMessage(2, 'M'));
    rest.seed(DM, noticeMessage(2, 'O'), true);
    const res = await post(call());
    expect(res.status).toBe(409);
    expect(res.body.channel).toBe('posted');
    expect(rest.creates(C)).toHaveLength(1);
    const copy = rest.messages.get(C)?.[0];
    expect(copy.nonce).toBe(copyTieNonce(C));
    expect(isTie(copy)).toBe(true);
  });
});

describe('sa14: the tie copies this process remembers', () => {
  it('a tie copy of generation 2 does not stand for the tie copy of generation 3 when the channel cannot be read', async () => {
    await firstTieCopy();
    answers = [main(3, 'M', inChannel(C))];
    rest.seed(DM, noticeMessage(3, 'O'), true);
    rest.fail('get', channelRead(C), httpError(500, 'Internal Server Error'));
    const res = await post(call(3));
    expect(res.status).toBe(409);
    expect(res.body.channel).toBe('posted');
    expect(rest.creates(C)).toHaveLength(2);
    expect(rest.messages.get(C)?.[0].nonce).toBe(copyTieNonce(C, 3));
    expect(res.body.note ?? '').not.toContain("can't confirm that the copy");
  });

  it('a tie copy does not stand for the ordinary copy at the same generation when the channel cannot be read', async () => {
    await firstTieCopy();
    rest.messages.set(DM, []);
    rest.pinned.clear();
    rest.seed(DM, noticeMessage(2, 'M'), true);
    rest.fail('get', channelRead(C), httpError(500, 'Internal Server Error'));
    const res = await post(call());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, posted: false, channel: 'posted' });
    expect(rest.creates(C)).toHaveLength(2);
    const copy = rest.messages.get(C)?.[0];
    expect(copy.nonce).toBe(copyNonce(C));
    expect(isTie(copy)).toBe(false);
  });

  it('an ordinary copy does not stand for the tie copy at the same generation when the channel cannot be read', async () => {
    const first = await post(call());
    expect(first.body).toMatchObject({ success: true, posted: true, channel: 'posted' });
    expect(rest.creates(C)).toHaveLength(1);
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.fail('get', channelRead(C), httpError(500, 'Internal Server Error'));
    const res = await post(call());
    expect(res.status).toBe(409);
    expect(res.body.channel).toBe('posted');
    expect(rest.creates(C)).toHaveLength(2);
    const copy = rest.messages.get(C)?.[0];
    expect(copy.nonce).toBe(copyTieNonce(C));
    expect(isTie(copy)).toBe(true);
  });

  it('a tie copy in another channel posted later does not make this process forget the first one', async () => {
    await firstTieCopy();
    answers = [main(2, 'M', inChannel(C2))];
    const second = await post(call());
    expect(second.body.channel).toBe('posted');
    expect(rest.creates(C2)).toHaveLength(1);
    answers = [main(2, 'M', inChannel(C))];
    rest.fail('get', channelRead(C), httpError(500, 'Internal Server Error'));
    const third = await post(call());
    expect(third.status).toBe(409);
    expect(third.body.channel).toBe('already');
    expect(rest.creates(C)).toHaveLength(1);
    expect(third.body.note).toContain(`can't confirm that the copy in channel ${C} of the notice saying that two machines announced generation 2 is still there`);
  });

  it('a 404 on the read of a channel that holds a remembered tie copy is kept as the channel\'s last refusal', async () => {
    await firstTieCopy();
    rest.messages.set(C, []);
    rest.expireNonces();
    rest.fail('get', channelRead(C), discordError(404, 10003, 'Unknown Channel'));
    const res = await post(call());
    expect(res.status).toBe(409);
    expect(res.body.channel).toBe('already');
    expect(rest.creates(C)).toHaveLength(1);
    expect(ownerChannelState().lastRefusal).toMatchObject({ channelId: C, text: 'the channel does not exist, or the bot is not in its server' });
  });

  it('a remembered tie copy whose budget ends exactly at the copy step: the copy fails with the budget gone, not already', async () => {
    await firstTieCopy();
    rest.seed(DM, noticeMessage(1, 'Z'), true);
    const realNow = Date.now.bind(Date);
    const start = realNow();
    let clock = start;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    rest.on('delete', /^\/channels\/\d+\/messages\/pins\/\w+$/, () => { clock = start + SWITCH_MS; return undefined; });
    const res = await post(call());
    expect(res.status).toBe(409);
    expect(res.body.channel).toBe('failed');
    expect(res.body.note).toBe(`The notice is in the owner's DMs, but its copy in channel ${C} was not posted (${BUDGET})`);
    expect(rest.calls.filter(c => c.method === 'get' && channelRead(C).test(c.route))).toHaveLength(1);
  });
});

describe('sa14: the tie step in the owner\'s DMs', () => {
  it('a tie notice of this machine at an older generation does not stand for the one of generation 2', async () => {
    rest.seed(DM, noticeMessage(1, 'M', ['X']));
    rest.seed(DM, noticeMessage(2, 'O'), true);
    answers = [main(2, 'M', { kind: 'none' })];
    const res = await post(call());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: true, present: true, pinned: true });
    const creates = rest.creates(DM);
    expect(creates).toHaveLength(1);
    expect(creates[0].options.body.nonce).toBe(tieNonce);
  });

  it('a tie notice that is not posted names the chosen channel when its setting could not be read', async () => {
    answers = [main(2, 'M', { kind: 'unreadable', cause: 'the database did not answer within 5 s' })];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.fail('post', dmMessages, refusedDm());
    const res = await post(call());
    expect(res.status).toBe(409);
    expect(res.body.channel).toBe('failed');
    expect(res.body.note).toContain("The copy in the chosen channel of the notice saying that two machines announced generation 2 was not posted: the notice is not in the owner's DMs");
  });

  it('a notice posted now but missing from the read after it: this machine is named, and the notice is pinned', async () => {
    answers = [main(2, 'M', { kind: 'none' })];
    const other = { id: 'other1', channel_id: DM, author: { id: BOT }, timestamp: DATE, ...noticeMessage(2, 'O') };
    let reads = 0;
    rest.on('get', dmMessages, () => (++reads === 1 ? undefined : [other]));
    let posts = 0;
    rest.on('post', dmMessages, () => { if (++posts > 1) throw refusedDm(); return undefined; });
    const res = await post(call());
    expect(res.status).toBe(409);
    expect(reads).toBe(2);
    const own = (rest.messages.get(DM) ?? []).find(m => m.nonce === ownNonce);
    expect(own).toBeDefined();
    expect(res.body.tie).toEqual({ generation: 2, machines: ['M', 'O'], named: ['M', 'O'] });
    expect(res.body).toMatchObject({ posted: true, present: true, pinned: true, channel: 'none' });
    expect(rest.pinned.get(DM)?.has(own.id)).toBe(true);
    expect(rest.calls.some(c => c.method === 'put' && c.route === `/channels/${DM}/messages/pins/${own.id}`)).toBe(true);
  });

  it('a notice posted now that the read after it shows pinned is not pinned again', async () => {
    answers = [main(2, 'M', { kind: 'none' })];
    const other = { id: 'other1', channel_id: DM, author: { id: BOT }, timestamp: DATE, ...noticeMessage(2, 'O') };
    let reads = 0;
    rest.on('get', dmMessages, () => (++reads === 1 ? undefined : [other, ...(rest.messages.get(DM) ?? [])]));
    let pinReads = 0;
    rest.on('get', dmPins, () => {
      if (++pinReads > 1) for (const m of rest.messages.get(DM) ?? []) if (m.nonce === ownNonce) rest.pinned.set(DM, new Set([m.id]));
      return undefined;
    });
    let posts = 0;
    rest.on('post', dmMessages, () => { if (++posts > 1) throw refusedDm(); return undefined; });
    rest.fail('put', /^\/channels\/\d+\/messages\/pins\/\w+$/, discordError(403, 50013, 'Missing Permissions'));
    const res = await post(call());
    expect(res.status).toBe(409);
    expect(pinReads).toBe(2);
    expect(res.body).toMatchObject({ posted: true, present: true, pinned: true, channel: 'none' });
    expect(res.body.note ?? '').not.toContain('not pinned');
    expect(rest.calls.filter(c => c.method === 'put')).toHaveLength(0);
  });
});
