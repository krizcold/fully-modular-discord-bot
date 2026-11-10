import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { hashNonce, NOTICE_TITLE, noticeEmbed, pinMessage } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel, ownerChannelState } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { BOT, DM, FakeOwnerRest, discordError, httpError, rateLimitError } from '../helpers/fakeOwnerRest';

// NB24 section 8 test 7: the switch-notice route when another machine announced the same generation, over a fake
// prober and the shared fake REST with Discord's nonce dedupe.

const TOKEN = 'nb24-token';
const C = '500000000000000001';
const A = 'postgres://bot:pw@a.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
const BUDGET = "the route's budget of 25 s ran out";
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;
let answers: ProbeAnswer[] = [];

function main(generation: number, machine: string, channel?: string): ProbeAnswer {
  const [e] = parseAddressList(A);
  return {
    kind: 'answered', address: e.shown, entry: A, inRecovery: false, readOnly: false, generation, machine, since: DATE,
    sysid: 'sys-a', started: 'start-a', storeId: 'store-1', ownerChannel: channel ? { kind: 'id', id: channel } : { kind: 'none' },
  } as ProbeAnswer;
}

function noticeMessage(generation: number, machine: string, also?: string[]) {
  return { embeds: [noticeEmbed({ machine, generation, date: DATE }, also)] };
}

const mainNonce = (g: number, m: string) => hashNonce(JSON.stringify(['main', g, m]));
const tieNonce = (g: number, m: string) => hashNonce(JSON.stringify(['main', g, m, 'tie']));
const isTie = (body: any) => body?.embeds?.[0]?.fields?.some((f: any) => f.name === 'Also announced') === true;
const messageById = (channel: string, id: string) => (rest.messages.get(channel) ?? []).find(m => m.id === id);

const list = (ms: string[]) => (ms.length <= 1 ? ms.join('') : `${ms.slice(0, -1).join(', ')} and ${ms[ms.length - 1]}`);
const EVERY = "The bot stops on every machine that reads the switch notices, until the owner presses Keep this machine as the main in one machine's Bot Manager";
const ONE = (named: string) => `The bot on M stops at its next read of the switch notices; the bot on ${named} stops only once a notice for M is in the owner's DMs, and the next switch-notice call for generation 2 tries again`;
const tieError = (machines: string[], clause: string, closing: string) =>
  `${list(machines)} announced main generation 2; can't confirm which is the main. ${clause} ${closing}`;
const tail = (named: string) => `, so the bot on ${named} may still be writing.`;
const REFUSED_NOTE = (cause: string) => `The notice saying that two machines announced generation 2 was not posted (${cause}); the next switch-notice call for generation 2 tries again`;
const UNCONFIRMED_NOTE = (cause: string) => `can't confirm whether the notice saying that two machines announced generation 2 was posted: ${cause}`;
const PIN_NOTE = (cause: string) => `Posted, but not pinned (${cause}); a machine that comes back after more than 100 later messages in that conversation will not find it`;
const TIE_DESCRIPTION = (others: string) => `M also announced itself as the main database of this bot at generation 2, since ${DATE}, while ${others} announced the same generation. The bot stops on every machine that reads these notices, until the owner presses Keep this machine as the main in one machine's Bot Manager and rejoins the others as copies.`;
const copyTieNonce = (channel: string) => hashNonce(JSON.stringify(['copy', channel, 2, 'M', 'tie']));

/** The clock moves past the route's deadline: the request in hand has its answer, the next one finds no time left. */
function budgetGone(): void {
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
}

beforeAll(async () => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  app = await startApp(a => a.use('/api/managed', createManagedRoutes({} as BotManager)));
});
afterAll(async () => {
  await app.close();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
});
beforeEach(() => {
  rest = new FakeOwnerRest(300);
  _setManagedTiming({ notifyMs: 600, switchMs: 900 });
  _resetOwnerChannel();
  _resetWebuiChoice();
  answers = [main(2, 'M')];
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
  vi.restoreAllMocks();
});

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/switch-notice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const call = { machine: 'M', generation: 2, date: DATE };
const repeatCall = { ...call, repeat: true };
const dmCreate = new RegExp(`^/channels/${DM}/messages$`);
const dmRead = new RegExp(`^/channels/${DM}/messages$`);

/** O's notice appears in the DM while M's first create runs, as when two machines post at once. */
function oPostsDuringMyCreate(generation = 2, machine = 'O'): void {
  let done = false;
  rest.on('post', dmCreate, () => {
    if (!done) { done = true; rest.seed(DM, noticeMessage(generation, machine)); }
    return undefined;
  });
}

/** Fails the n-th create of the DM (1 = the first) with the given answer. */
function nthCreate(n: number, answer: () => unknown): void {
  let count = 0;
  rest.on('post', dmCreate, () => {
    count += 1;
    return count === n ? answer() : undefined;
  });
}

/** Another caller's request that the fake answers 404, which clears the module's cached ids. */
async function anotherCallerGets404(): Promise<void> {
  await pinMessage('999999999999999999', 'gone', Date.now() + 1_000);
}

describe('NB24 test 7: the nonces', () => {
  it('(a) an empty DM: the create carries the nonce of the generation and the machine', async () => {
    expect((await post(call)).status).toBe(200);
    const [create] = rest.creates(DM);
    expect(create.options.body).toMatchObject({ nonce: hashNonce('["main",2,"M"]'), enforce_nonce: true });
  });

  it("(a2) machine 'A:tie' posts at 2, then machine A's tie notice: two nonces, two messages", async () => {
    answers = [main(2, 'A:tie')];
    expect((await post({ ...call, machine: 'A:tie' })).status).toBe(200);
    answers = [main(2, 'A')];
    expect((await post({ ...call, machine: 'A' })).status).toBe(409);
    const creates = rest.creates(DM);
    expect(creates).toHaveLength(2);
    expect(creates[0].options.body.nonce).not.toBe(creates[1].options.body.nonce);
    expect(creates[1].options.body.nonce).toBe(tieNonce(2, 'A'));
    expect(rest.messages.get(DM)).toHaveLength(2);
  });
});

describe('NB24 test 7: step 3, the tie found in the first read', () => {
  it("(b) O's at 2: the tie notice posted with its nonce, pinned, older pins unpinned, 409 posted true", async () => {
    const older = rest.seed(DM, noticeMessage(1, 'OLD'), true);
    rest.seed(DM, noticeMessage(2, 'O'), true);
    const res = await post(call);
    expect(res).toEqual({
      status: 409,
      body: {
        success: false, error: tieError(['M', 'O'], 'The notice for M was posted.', EVERY),
        tie: { generation: 2, machines: ['M', 'O'], named: ['M', 'O'] }, posted: true, present: true, pinned: true, channel: 'none',
      },
    });
    const creates = rest.creates(DM);
    expect(creates).toHaveLength(1);
    expect(creates[0].options.body.nonce).toBe(tieNonce(2, 'M'));
    expect(creates[0].options.body.embeds[0]).toMatchObject({
      title: NOTICE_TITLE, timestamp: DATE,
      fields: [{ name: 'Machine', value: 'M' }, { name: 'Generation', value: '2' }, { name: 'Also announced', value: 'O' }],
    });
    expect(creates[0].options.body.embeds[0].description).toBe(TIE_DESCRIPTION('O'));
    const tieMessage = rest.messages.get(DM)![0];
    expect(tieMessage.embeds[0].description).toBe(TIE_DESCRIPTION('O'));
    expect(rest.pinned.get(DM)!.has(tieMessage.id)).toBe(true);
    expect(rest.pinned.get(DM)!.has(older.id)).toBe(false);
  });

  it("(c) O's and M's ordinary at 2: one tie notice, M's ordinary untouched, 409 posted true", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    const mine = rest.seed(DM, noticeMessage(2, 'M'));
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: true, present: true, pinned: true });
    expect(rest.creates(DM)).toHaveLength(1);
    expect(isTie(rest.creates(DM)[0].options.body)).toBe(true);
    expect(messageById(DM, mine.id).embeds).toEqual(noticeMessage(2, 'M').embeds);
    expect(rest.pinned.get(DM)!.has(mine.id)).toBe(false);
  });

  it("(d) O's and M's unpinned tie notice at 2: a pin of M's tie notice, no create, 409 posted false, present true", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    const mineTie = rest.seed(DM, noticeMessage(2, 'M', ['O']));
    const res = await post(call);
    expect(res).toEqual({
      status: 409,
      body: {
        success: false, error: tieError(['M', 'O'], 'The notice for M was already posted.', EVERY),
        tie: { generation: 2, machines: ['M', 'O'], named: ['M', 'O'] }, posted: false, present: true, pinned: true, channel: 'none',
      },
    });
    expect(rest.creates()).toHaveLength(0);
    expect(rest.calls.some(c => c.method === 'put' && c.route.endsWith(`/pins/${mineTie.id}`))).toBe(true);
  });

  it("(o3) M's tie notice at 2 alone (O's ordinary gone): no create, 409 posted false, present true", async () => {
    rest.seed(DM, noticeMessage(2, 'M', ['O']), true);
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ tie: { generation: 2, machines: ['M', 'O'], named: ['M', 'O'] }, posted: false, present: true });
    expect(res.body.error).toBe(tieError(['M', 'O'], 'The notice for M was already posted.', EVERY));
    expect(rest.creates()).toHaveLength(0);
  });

  it("(g2) O's and M's unpinned ordinary at 2, the tie create answering 429: M's ordinary pinned, 409 posted false, present true", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    const mine = rest.seed(DM, noticeMessage(2, 'M'));
    rest.fail('post', dmCreate, rateLimitError(1_000));
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: false, present: true, pinned: true });
    expect(res.body.note).toBe(REFUSED_NOTE('Discord refused it: HTTP 429 (rate limited, retry after 1 s)'));
    expect(rest.pinned.get(DM)!.has(mine.id)).toBe(true);
  });

  it("(i2) O's at 2 and the tie create answered with a message with no embed: 409 refused, never a 502", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.on('post', dmCreate, () => ({ id: 'plain', channel_id: DM, author: { id: BOT }, content: 'hello' }));
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: false, present: false, tie: { named: ['O'] } });
    expect(res.body.error).toBe(tieError(['M', 'O'], `The notice for M was not posted (Discord returned another message instead)${tail('O')}`, ONE('O')));
  });

  it('(j) the tie create refused with 403 50007: 409 posted false, present false, no channel request, the whole text', async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.fail('post', dmCreate, discordError(403, 50007, 'Cannot send messages to this user'));
    const res = await post(call);
    expect(res).toEqual({
      status: 409,
      body: {
        success: false,
        error: tieError(['M', 'O'], `The notice for M was not posted (Discord refused it: 50007 Cannot send messages to this user)${tail('O')}`, ONE('O')),
        tie: { generation: 2, machines: ['M', 'O'], named: ['O'] }, posted: false, present: false, pinned: false, channel: 'failed',
        note: `The copy in channel ${C} of the notice saying that two machines announced generation 2 was not posted: the notice is not in the owner's DMs`,
      },
    });
    expect(rest.calls.some(c => c.route.startsWith(`/channels/${C}`))).toBe(false);
  });

  it("(j) the tie create timing out: posted null, present null, the can't-confirm clause", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.hang('post', dmCreate);
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: null, present: null, tie: { named: ['O'] } });
    expect(res.body.error).toBe(tieError(['M', 'O'], `Whether the notice for M was posted can't be confirmed (a timeout)${tail('O')}`, ONE('O')));
  });

  it('(j) a 429, then a second call whose create answers: one tie notice, posted true, the every-machine closing', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    nthCreate(1, () => { throw rateLimitError(1_000); });
    expect((await post(call)).body.posted).toBe(false);
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: true, present: true, tie: { named: ['M', 'O'] } });
    expect(res.body.error).toBe(tieError(['M', 'O'], 'The notice for M was posted.', EVERY));
    expect((rest.messages.get(DM) ?? []).filter(m => isTie(m))).toHaveLength(1);
  });

  it("(j2) O's ordinary and O's tie notice naming M, the tie create answering 429: named M and O, no tail, the every-machine closing", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.seed(DM, noticeMessage(2, 'O', ['M']));
    rest.fail('post', dmCreate, rateLimitError(1_000));
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: false, present: false, tie: { generation: 2, machines: ['M', 'O'], named: ['M', 'O'] } });
    expect(res.body.error).toBe(tieError(['M', 'O'], 'The notice for M was not posted (Discord refused it: HTTP 429 (rate limited, retry after 1 s)).', EVERY));
  });

  it("(j2) O1's ordinary and O2's tie notice naming O1, the create answering 403: named O1 and O2", async () => {
    rest.seed(DM, noticeMessage(2, 'O1'), true);
    rest.seed(DM, noticeMessage(2, 'O2', ['O1']));
    rest.fail('post', dmCreate, discordError(403, 50007, 'Cannot send messages to this user'));
    const res = await post(call);
    expect(res.body).toMatchObject({ posted: false, present: false, tie: { machines: ['M', 'O1', 'O2'], named: ['O1', 'O2'] } });
    expect(res.body.error).toBe(tieError(['M', 'O1', 'O2'], 'The notice for M was not posted (Discord refused it: 50007 Cannot send messages to this user).', EVERY));
  });

  it("(o) the pin answering 500: 409 posted true, present true, pinned false and the pin note", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.fail('put', /\/messages\/pins\//, discordError(500, 0, 'Internal Server Error'));
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: true, present: true, pinned: false, note: PIN_NOTE('HTTP 500 (Internal Server Error)') });
  });

  it("(o4) O's at 2 and the budget gone when the tie create is due: no create request, not posted with the budget cause", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.on('get', dmRead, () => { budgetGone(); return undefined; });
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(rest.creates()).toHaveLength(0);
    expect(rest.calls.some(c => c.method === 'put' || c.method === 'delete')).toBe(false);
    expect(res.body).toMatchObject({ posted: false, present: false, pinned: false, tie: { named: ['O'] } });
    expect(res.body.error).toBe(tieError(['M', 'O'], `The notice for M was not posted (${BUDGET})${tail('O')}`, ONE('O')));
    expect(rest.messages.get(DM)).toHaveLength(1);
  });

  it("(o4) the first read's messages request aborted at its bound: the read fails, the first send posts, the re-read finds O's, 409 posted true", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    let once = false;
    rest.on('get', dmRead, async c => {
      if (!once) { once = true; await rest.delay(950, c); }
      return undefined;
    });
    const res = await post(call);
    expect(rest.aborted.some(c => c.method === 'get' && dmRead.test(c.route))).toBe(true);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: true, present: true, tie: { machines: ['M', 'O'], named: ['M', 'O'] } });
    const creates = rest.creates(DM);
    expect(creates).toHaveLength(2);
    expect(creates[0].options.body.nonce).toBe(mainNonce(2, 'M'));
    expect(creates[1].options.body.nonce).toBe(tieNonce(2, 'M'));
    expect(rest.messages.get(DM)).toHaveLength(3);
  });

  it("(o4) O's at 2, the cached ids cleared and the owner lookup hanging until its bound: no create request, not posted with a timeout", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.fail('put', /^\/channels\/999999999999999999\//, discordError(404, 10008, 'Unknown Message'));
    let once = false;
    rest.on('get', dmRead, async () => {
      if (!once) { once = true; await anotherCallerGets404(); rest.hang('get', /^\/applications\/@me$/); }
      return undefined;
    });
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(rest.creates()).toHaveLength(0);
    expect(res.body).toMatchObject({ posted: false, present: false });
    expect(res.body.error).toBe(tieError(['M', 'O'], `The notice for M was not posted (a timeout)${tail('O')}`, ONE('O')));
  });

  it("(k) the copy channel holding O's ordinary copy: the tie copy with its nonce, channel posted", async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.seed(C, noticeMessage(2, 'O'));
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body.channel).toBe('posted');
    const copies = rest.creates(C);
    expect(copies).toHaveLength(1);
    expect(copies[0].options.body.nonce).toBe(hashNonce(`["copy","${C}",2,"M","tie"]`));
    expect(isTie(copies[0].options.body)).toBe(true);
  });

  it("(k) the copy channel already holding M's tie copy: no create, channel already", async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.seed(C, noticeMessage(2, 'M', ['O']));
    const res = await post(call);
    expect(res.body.channel).toBe('already');
    expect(rest.creates(C)).toHaveLength(0);
  });

  it("(k) case 12: M's tie notice already in the DM, its tie copy missing from the channel: no DM create, the tie copy posted", async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.seed(DM, noticeMessage(2, 'M', ['O']), true);
    rest.seed(C, noticeMessage(2, 'O'));
    const res = await post(call);
    expect(res).toEqual({
      status: 409,
      body: {
        success: false, error: tieError(['M', 'O'], 'The notice for M was already posted.', EVERY),
        tie: { generation: 2, machines: ['M', 'O'], named: ['M', 'O'] }, posted: false, present: true, pinned: true, channel: 'posted',
      },
    });
    expect(rest.creates(DM)).toHaveLength(0);
    const copies = rest.creates(C);
    expect(copies).toHaveLength(1);
    expect(copies[0].options.body.nonce).toBe(copyTieNonce(C));
    const stored = rest.messages.get(C)!.find(m => m.nonce === copyTieNonce(C))!;
    expect(stored.embeds[0]).toMatchObject({ description: TIE_DESCRIPTION('O'), fields: [{ name: 'Machine', value: 'M' }, { name: 'Generation', value: '2' }, { name: 'Also announced', value: 'O' }] });
    expect(rest.messages.get(C)).toHaveLength(2);
  });

  it("step 3 with M's unpinned tie notice found and its pin answering 500: 409 posted false, present true, pinned false, the found-notice pin note", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    const mineTie = rest.seed(DM, noticeMessage(2, 'M', ['O']));
    rest.fail('put', /\/messages\/pins\//, discordError(500, 0, 'Internal Server Error'));
    const res = await post(call);
    expect(res).toEqual({
      status: 409,
      body: {
        success: false, error: tieError(['M', 'O'], 'The notice for M was already posted.', EVERY),
        tie: { generation: 2, machines: ['M', 'O'], named: ['M', 'O'] }, posted: false, present: true, pinned: false, channel: 'none',
        note: "The notice for M is in the owner's DMs but not pinned (HTTP 500 (Internal Server Error)); a machine that comes back after more than 100 later messages in that conversation will not find it",
      },
    });
    expect(rest.creates()).toHaveLength(0);
    expect(rest.pinned.get(DM)!.has(mineTie.id)).toBe(false);
  });
});

describe('NB24 test 7: step 1 and step 2', () => {
  it("(e) M's alone at 2: 200 posted false, as today", async () => {
    rest.seed(DM, noticeMessage(2, 'M'), true);
    expect(await post(call)).toEqual({ status: 200, body: { success: true, posted: false, channel: 'none', note: 'A switch notice of generation 2 (M) is already posted; this one was not posted.' } });
  });

  it("(e) a notice at 3 and O's at 2: 200 posted false with newer; A's and C's at 3 give both", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.seed(DM, noticeMessage(3, 'A'), true);
    expect((await post(call)).body).toMatchObject({ success: true, posted: false, newer: { generation: 3, machines: ['A'] } });
    rest.seed(DM, noticeMessage(3, 'C'));
    expect((await post(call)).body).toMatchObject({ success: true, posted: false, newer: { generation: 3, machines: ['A', 'C'] } });
    expect(rest.creates()).toHaveLength(0);
  });
});

describe('NB24 test 7: step 4, the read after the post', () => {
  it("(f) an empty first read, the re-read holding O's and M's at 2: the tie notice, 409 posted true", async () => {
    oPostsDuringMyCreate();
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: true, present: true, tie: { machines: ['M', 'O'], named: ['M', 'O'] } });
    expect(rest.creates(DM)).toHaveLength(2);
    expect(isTie(rest.creates(DM)[1].options.body)).toBe(true);
    expect(rest.creates(DM)[1].options.body.nonce).toBe(tieNonce(2, 'M'));
  });

  it.each([
    ['403', () => discordError(403, 50007, 'Cannot send messages to this user'), REFUSED_NOTE('Discord refused it: 50007 Cannot send messages to this user')],
    ['500', () => httpError(500, 'Internal Server Error'), UNCONFIRMED_NOTE('HTTP 500 (Internal Server Error)')],
  ])('(g) as (f), the tie create answering %s: posted true, present true, the note, M\'s ordinary pinned before any unpin', async (_n, error, note) => {
    rest.seed(DM, noticeMessage(1, 'OLD'), true);
    oPostsDuringMyCreate();
    nthCreate(2, () => { throw error(); });
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: true, present: true, pinned: true, note });
    expect(res.body.error).toBe(tieError(['M', 'O'], 'The notice for M was posted.', EVERY));
    const mine = (rest.messages.get(DM) ?? []).find(m => m.nonce === mainNonce(2, 'M'))!;
    const pinAt = rest.calls.findIndex(c => c.method === 'put' && c.route.endsWith(`/pins/${mine.id}`));
    const unpinAt = rest.calls.findIndex(c => c.method === 'delete');
    expect(pinAt).toBeGreaterThan(-1);
    expect(unpinAt).toBeGreaterThan(pinAt);
  });

  it("(g) as (f), the tie notice landing and its pin answering 500: M's ordinary is pinned too", async () => {
    oPostsDuringMyCreate();
    rest.on('put', /\/messages\/pins\//, call => {
      const id = call.route.split('/').pop()!;
      if (isTie(messageById(DM, id))) throw discordError(500, 0, 'Internal Server Error');
      return undefined;
    });
    const res = await post(call);
    expect(res.status).toBe(409);
    const mine = (rest.messages.get(DM) ?? []).find(m => m.nonce === mainNonce(2, 'M'))!;
    expect(rest.pinned.get(DM)!.has(mine.id)).toBe(true);
    expect(res.body).toMatchObject({ posted: true, present: true, pinned: true });
  });

  it("(i2) as (f), the tie create answered with a message with no embed: 409 posted true, present true, the note's refused form", async () => {
    oPostsDuringMyCreate();
    nthCreate(2, () => ({ id: 'plain', channel_id: DM, author: { id: BOT }, content: 'hello' }));
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: true, present: true, note: REFUSED_NOTE('Discord returned another message instead') });
  });

  it('(h) the re-read failing: 200 posted true, tieChecked false, the note', async () => {
    let reads = 0;
    rest.on('get', /\/messages\/pins$/, () => {
      reads += 1;
      if (reads === 2) throw discordError(500, 0, 'Internal Server Error');
      return undefined;
    });
    expect((await post(call)).body).toEqual({
      success: true, posted: true, pinned: true, channel: 'none', tieChecked: false,
      note: "Posted, but whether another machine also announced generation 2 can't be confirmed: the notices could not be read again (HTTP 500 (Internal Server Error))",
    });
  });

  it('(h) the re-read starting after the budget: the same with the budget cause', async () => {
    rest.on('post', dmCreate, () => { budgetGone(); return undefined; });
    const res = await post(call);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, posted: true, pinned: false, tieChecked: false });
    expect(res.body.note).toContain(`Posted, but whether another machine also announced generation 2 can't be confirmed: the notices could not be read again (${BUDGET})`);
    expect(rest.calls.filter(c => c.method === 'get' && /\/messages\/pins$/.test(c.route))).toHaveLength(1);
    expect(rest.calls.some(c => c.method === 'put')).toBe(false);
    expect(rest.messages.get(DM)!.filter(m => m.nonce === mainNonce(2, 'M'))).toHaveLength(1);
  });

  it("(i) Discord's answer is O's notice at 2: 409 posted false, present false, named O, the whole text", async () => {
    rest.on('post', dmCreate, () => ({ id: 'oMsg', channel_id: DM, author: { id: BOT }, ...noticeMessage(2, 'O') }));
    const res = await post(call);
    expect(res).toEqual({
      status: 409,
      body: {
        success: false,
        error: tieError(['M', 'O'], `Discord answered with the notice of O instead of posting one for M${tail('O')}`, ONE('O')),
        tie: { generation: 2, machines: ['M', 'O'], named: ['O'] }, posted: false, present: false, pinned: false, channel: 'none',
      },
    });
    expect(res.body.error.startsWith('M and O announced main generation 2')).toBe(true);
    expect(res.body.error).not.toContain('every machine');
  });

  it.each([
    ["M's notice at 1", () => ({ id: 'm1', channel_id: DM, author: { id: BOT }, ...noticeMessage(1, 'M') })],
    ['a message with no embed', () => ({ id: 'plain', channel_id: DM, author: { id: BOT }, content: 'hello' })],
  ])("(i) Discord's answer is %s: 502 another message", async (_n, answer) => {
    rest.on('post', dmCreate, answer);
    expect(await post(call)).toEqual({
      status: 502,
      body: { success: false, error: "Discord refused the switch notice to the bot's owner (Discord returned another message instead). A machine whose database was the main will not learn from Discord that it was replaced: keep it off, or rejoin it as a live copy, before it starts again." },
    });
  });

  it("(l) an empty DM and the copy channel holding O's ordinary copy: M's ordinary copy with its nonce, channel posted", async () => {
    answers = [main(2, 'M', C)];
    rest.seed(C, noticeMessage(2, 'O'));
    const res = await post(call);
    expect(res.body).toMatchObject({ success: true, posted: true, channel: 'posted' });
    const copies = rest.creates(C);
    expect(copies).toHaveLength(1);
    expect(copies[0].options.body.nonce).toBe(hashNonce(`["copy","${C}",2,"M"]`));
  });

  it("(m) the first pins read failing and the DM holding O's at 2: the ordinary create, the re-read, the tie create, 409 posted true", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    let reads = 0;
    rest.on('get', /\/messages\/pins$/, () => {
      reads += 1;
      if (reads === 1) throw discordError(500, 0, 'Internal Server Error');
      return undefined;
    });
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body.posted).toBe(true);
    const creates = rest.creates(DM);
    expect(creates).toHaveLength(2);
    expect(isTie(creates[0].options.body)).toBe(false);
    expect(isTie(creates[1].options.body)).toBe(true);
  });

  it("(n) another caller's 404 during the create clears the cached ids; the answer is still read as M's notice", async () => {
    rest.fail('put', /^\/channels\/999999999999999999\//, discordError(404, 10008, 'Unknown Message'));
    let once = false;
    rest.on('post', dmCreate, async () => {
      if (!once) { once = true; await anotherCallerGets404(); }
      return undefined;
    });
    const res = await post(call);
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(true);
  });

  it("(o2) 50 older pinned notices with slow unpins, the re-read holding O's at 2: the re-read before any pin, the tie create before any unpin", async () => {
    for (let i = 0; i < 50; i++) rest.seed(DM, noticeMessage(1, `OLD${i}`), true);
    rest.on('delete', /\/messages\/pins\//, async c => { await rest.delay(1_000, c); return undefined; });
    oPostsDuringMyCreate();
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body.posted).toBe(true);
    const pinsReads = rest.calls.map((c, i) => [c, i] as const).filter(([c]) => c.method === 'get' && /\/messages\/pins$/.test(c.route)).map(([, i]) => i);
    const firstPut = rest.calls.findIndex(c => c.method === 'put');
    const firstDelete = rest.calls.findIndex(c => c.method === 'delete');
    const creates = rest.calls.map((c, i) => [c, i] as const).filter(([c]) => c.method === 'post' && dmCreate.test(c.route)).map(([, i]) => i);
    expect(pinsReads[1]).toBeLessThan(firstPut);
    expect(creates[1]).toBeLessThan(firstDelete);
    const tieMessage = (rest.messages.get(DM) ?? []).find(m => isTie(m))!;
    const mine = (rest.messages.get(DM) ?? []).find(m => m.nonce === mainNonce(2, 'M'))!;
    expect(rest.pinned.get(DM)!.has(tieMessage.id)).toBe(true);
    expect(rest.pinned.get(DM)!.has(mine.id)).toBe(false);
  });

  it("(o2) the re-read holding O's notice at 3: 200 posted true with newer and the posted-but-newer note", async () => {
    oPostsDuringMyCreate(3, 'O');
    expect((await post(call)).body).toEqual({
      success: true, posted: true, pinned: true, channel: 'none', newer: { generation: 3, machines: ['O'] },
      note: "Posted, but a switch notice of generation 3 (O) is already in the owner's DMs",
    });
  });

  it("(o4) as (f), the budget gone when the tie create is due: posted true, present true, the note's refused form with the budget cause", async () => {
    oPostsDuringMyCreate();
    let reads = 0;
    rest.on('get', dmRead, () => {
      reads += 1;
      if (reads === 2) budgetGone();
      return undefined;
    });
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(rest.creates(DM)).toHaveLength(1);
    expect(res.body).toMatchObject({ posted: true, present: true, pinned: false, tie: { machines: ['M', 'O'], named: ['M', 'O'] } });
    expect(res.body.error).toBe(tieError(['M', 'O'], 'The notice for M was posted.', EVERY));
    expect(res.body.note).toContain(REFUSED_NOTE(BUDGET));
    expect(rest.messages.get(DM)!.filter(m => isTie(m))).toHaveLength(0);
  });

  it("(o4) as (f), the budget gone after the re-read: the pin that was never sent is noted with the budget cause, not a timeout", async () => {
    oPostsDuringMyCreate();
    let reads = 0;
    rest.on('get', dmRead, () => {
      reads += 1;
      if (reads === 2) budgetGone();
      return undefined;
    });
    const res = await post(call);
    expect(rest.calls.some(c => c.method === 'put')).toBe(false);
    expect(res.body.note).toBe(`${PIN_NOTE(BUDGET)} ${REFUSED_NOTE(BUDGET)}`);
  });

  it('(o5) an empty DM, the budget gone when the ordinary create is due: 502 not sent with the budget cause, no unknown', async () => {
    rest.fail('put', /^\/channels\/999999999999999999\//, discordError(404, 10008, 'Unknown Message'));
    let once = false;
    rest.on('get', dmRead, async () => {
      if (!once) {
        once = true;
        await anotherCallerGets404();
        rest.on('get', /^\/applications\/@me$/, () => { budgetGone(); return undefined; });
      }
      return undefined;
    });
    const res = await post(call);
    expect(rest.creates()).toHaveLength(0);
    expect(res).toEqual({
      status: 502,
      body: { success: false, error: `The switch notice to the bot's owner was not sent (${BUDGET}); nothing was posted. A machine whose database was the main will not learn from Discord that it was replaced: keep it off, or rejoin it as a live copy, before it starts again.` },
    });
  });

  it('(o5) an empty DM, the cold-cache owner lookup timing out: 502 not sent with a timeout, no unknown', async () => {
    rest.fail('put', /^\/channels\/999999999999999999\//, discordError(404, 10008, 'Unknown Message'));
    let once = false;
    rest.on('get', dmRead, async () => {
      if (!once) { once = true; await anotherCallerGets404(); rest.hang('get', /^\/applications\/@me$/); }
      return undefined;
    });
    const res = await post(call);
    expect(rest.creates()).toHaveLength(0);
    expect(res).toEqual({
      status: 502,
      body: { success: false, error: "The switch notice to the bot's owner was not sent (a timeout); nothing was posted. A machine whose database was the main will not learn from Discord that it was replaced: keep it off, or rejoin it as a live copy, before it starts again." },
    });
  });

  it('(o5) the budget gone before the copy create: channel failed with the budget cause, no channel refusal recorded', async () => {
    answers = [main(2, 'M', C)];
    rest.on('get', new RegExp(`^/channels/${C}/messages$`), () => { budgetGone(); return undefined; });
    const res = await post(call);
    expect(rest.creates(C)).toHaveLength(0);
    expect(rest.messages.get(C) ?? []).toHaveLength(0);
    expect(res.body).toMatchObject({ posted: true, channel: 'failed' });
    expect(res.body.note).toContain(`The notice is in the owner's DMs, but its copy in channel ${C} was not posted (${BUDGET})`);
    expect(ownerChannelState().lastRefusal).toBeNull();
  });
});

describe('NB24 test 7: the repeat', () => {
  beforeEach(() => { answers = [main(2, 'M', C)]; });

  it("(p) M's at 2 pinned and no copy among the channel's newest: no create, no channel request, 200 posted false with no channel", async () => {
    rest.seed(DM, noticeMessage(2, 'M'), true);
    rest.expireNonces();
    expect(await post(repeatCall)).toEqual({ status: 200, body: { success: true, posted: false, note: 'A switch notice of generation 2 (M) is already posted; this one was not posted.' } });
    expect(rest.creates()).toHaveLength(0);
    expect(rest.calls.some(c => c.route.startsWith(`/channels/${C}`))).toBe(false);
  });

  it.each([
    ['answers 500', () => rest.fail('get', /\/messages\/pins$/, discordError(500, 0, 'Internal Server Error')), 'HTTP 500 (Internal Server Error)'],
    ['times out', () => rest.hang('get', /\/messages\/pins$/), 'a timeout'],
  ])('(q) a repeat whose pins read %s: 503, no create, no pin, no unpin', async (_n, arrange, cause) => {
    rest.seed(DM, noticeMessage(1, 'OLD'), true);
    arrange();
    rest.expireNonces();
    expect(await post(repeatCall)).toEqual({ status: 503, body: { success: false, error: `The switch notices could not be read (${cause}); nothing was posted` } });
    expect(rest.creates()).toHaveLength(0);
    expect(rest.calls.some(c => c.method === 'put' || c.method === 'delete')).toBe(false);
  });

  it("(q) a repeat whose messages read finds the budget gone after the pins read: 503 with the budget cause, no messages request sent", async () => {
    rest.seed(DM, noticeMessage(1, 'OLD'), true);
    rest.on('get', /\/messages\/pins$/, () => { budgetGone(); return undefined; });
    rest.expireNonces();
    expect(await post(repeatCall)).toEqual({ status: 503, body: { success: false, error: `The switch notices could not be read (${BUDGET}); nothing was posted` } });
    expect(rest.calls.filter(c => c.method === 'get' && /\/messages\/pins$/.test(c.route))).toHaveLength(1);
    expect(rest.calls.some(c => c.method === 'get' && dmRead.test(c.route))).toBe(false);
    expect(rest.creates()).toHaveLength(0);
    expect(rest.calls.some(c => c.method === 'put' || c.method === 'delete')).toBe(false);
    expect(rest.messages.get(DM)).toHaveLength(1);
  });

  it("(k) M's tie copy deleted from a channel that still holds other messages: a repeat posts the tie copy again, channel posted", async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    const chat = rest.seed(C, { content: 'unrelated chat', author: { id: '700000000000000001' } });
    expect((await post(call)).body.channel).toBe('posted');
    const firstCopy = rest.messages.get(C)!.find(m => m.nonce === copyTieNonce(C))!;
    rest.messages.set(C, rest.messages.get(C)!.filter(m => m.id !== firstCopy.id));
    rest.expireNonces();
    const res = await post(repeatCall);
    expect(res).toEqual({
      status: 409,
      body: {
        success: false, error: tieError(['M', 'O'], 'The notice for M was already posted.', EVERY),
        tie: { generation: 2, machines: ['M', 'O'], named: ['M', 'O'] }, posted: false, present: true, pinned: true, channel: 'posted',
      },
    });
    expect(rest.creates(DM)).toHaveLength(1);
    const copies = rest.creates(C);
    expect(copies).toHaveLength(2);
    expect(copies[1].options.body.nonce).toBe(copyTieNonce(C));
    const stored = rest.messages.get(C)!;
    expect(stored).toHaveLength(2);
    expect(stored[1].id).toBe(chat.id);
    expect(stored[0].id).not.toBe(firstCopy.id);
    expect(stored[0].nonce).toBe(copyTieNonce(C));
    expect(stored[0].embeds[0]).toMatchObject({ description: TIE_DESCRIPTION('O'), fields: [{ name: 'Machine', value: 'M' }, { name: 'Generation', value: '2' }, { name: 'Also announced', value: 'O' }] });
  });

  it('(r) a repeat whose read finds nothing at or above 2: one ordinary create, the re-read, no channel request, 200 posted true', async () => {
    rest.expireNonces();
    expect(await post(repeatCall)).toEqual({ status: 200, body: { success: true, posted: true, pinned: true } });
    expect(rest.creates(DM)).toHaveLength(1);
    expect(rest.calls.filter(c => c.method === 'get' && /\/messages\/pins$/.test(c.route))).toHaveLength(2);
    expect(rest.calls.some(c => c.route.startsWith(`/channels/${C}`))).toBe(false);
  });

  it("(s) a repeat with O's at 2: the tie notice and the tie copy, 409", async () => {
    const older = rest.seed(DM, noticeMessage(1, 'OLD'), true);
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.expireNonces();
    const res = await post(repeatCall);
    expect(res).toEqual({
      status: 409,
      body: {
        success: false, error: tieError(['M', 'O'], 'The notice for M was posted.', EVERY),
        tie: { generation: 2, machines: ['M', 'O'], named: ['M', 'O'] }, posted: true, present: true, pinned: true, channel: 'posted',
      },
    });
    const creates = rest.creates(DM);
    expect(creates).toHaveLength(1);
    expect(creates[0].options.body.nonce).toBe(tieNonce(2, 'M'));
    expect(creates[0].options.body.embeds[0].description).toBe(TIE_DESCRIPTION('O'));
    const tieMessage = rest.messages.get(DM)!.find(m => m.nonce === tieNonce(2, 'M'))!;
    expect(rest.pinned.get(DM)!.has(tieMessage.id)).toBe(true);
    expect(rest.pinned.get(DM)!.has(older.id)).toBe(false);
    const copies = rest.creates(C);
    expect(copies).toHaveLength(1);
    expect(copies[0].options.body.nonce).toBe(copyTieNonce(C));
    expect(isTie(rest.messages.get(C)![0])).toBe(true);
  });

  it("(s) repeat 'yes' answers 400 with the whole text", async () => {
    expect(await post({ ...call, repeat: 'yes' })).toEqual({
      status: 400,
      body: { success: false, error: 'machine must be 1 to 256 characters, generation a whole number of at least 1, date an ISO 8601 UTC time ending in Z, and repeat, when given, true or false' },
    });
    expect(rest.calls).toHaveLength(0);
  });

  it('(s) a first send whose first read fails posts, as today', async () => {
    let reads = 0;
    rest.on('get', /\/messages\/pins$/, () => {
      reads += 1;
      if (reads === 1) throw discordError(500, 0, 'Internal Server Error');
      return undefined;
    });
    const res = await post(call);
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(true);
  });
});
