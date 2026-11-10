import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { hashNonce, noticeEmbed, pinMessage } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel, ownerChannelState } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { BOT, DM, FakeOwnerRest, discordError } from '../helpers/fakeOwnerRest';

// NB24 code review round 1: regression tests of the fixer's changes to the switch-notice route.

const TOKEN = 'nb24-fix1-token';
const C = '500000000000000001';
const A = 'postgres://bot:pw@a.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
const BUDGET = "the route's budget of 25 s ran out";
const ANOTHER = 'Discord returned another message instead';
const PIN_LATER = 'a machine that comes back after more than 100 later messages in that conversation will not find it';
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

const noticeMessage = (generation: number, machine: string, also?: string[]) => ({ embeds: [noticeEmbed({ machine, generation, date: DATE }, also)] });
const isTie = (body: any) => body?.embeds?.[0]?.fields?.some((f: any) => f.name === 'Also announced') === true;
const dmCreate = new RegExp(`^/channels/${DM}/messages$`);
const dmRead = dmCreate;
const channelRead = new RegExp(`^/channels/${C}/messages$`);
const call = { machine: 'M', generation: 2, date: DATE };
const memoryNote = `can't confirm that the copy in channel ${C} of the notice saying that two machines announced generation 2 is still there: the channel shows the bot no messages (it may lack Read Message History there); this web UI process posted it earlier and did not post it again`;
const SKIPPED = `The copy in channel ${C} of the notice saying that two machines announced generation 2 was not posted: the notice is not in the owner's DMs`;

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

describe('NB24-B-1: the channel of a 409 tie whose tie copy did not run', () => {
  it("a copy channel set and the tie create refused: channel failed with the note, nothing posted in it", async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.fail('post', dmCreate, discordError(403, 50007, 'Cannot send messages to this user'));
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body.channel).toBe('failed');
    expect(res.body.note).toBe(SKIPPED);
    expect(rest.creates(C)).toHaveLength(0);
  });

  it('no copy channel set and the tie create refused: channel none, no note', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.fail('post', dmCreate, discordError(403, 50007, 'Cannot send messages to this user'));
    const res = await post(call);
    expect(res.body).toMatchObject({ channel: 'none' });
    expect(res.body.note).toBeUndefined();
  });

  it("a copy channel set and Discord answering the ordinary create with O's notice: channel failed with the note", async () => {
    answers = [main(2, 'M', C)];
    rest.on('post', dmCreate, () => ({ id: 'oMsg', channel_id: DM, author: { id: BOT }, ...noticeMessage(2, 'O') }));
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: false, present: false, channel: 'failed', note: SKIPPED });
    expect(rest.creates(C)).toHaveLength(0);
  });

  it('a tie create that can not be confirmed: channel failed with the can\'t-confirm note', async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.hang('post', dmCreate);
    const res = await post(call);
    expect(res.body.channel).toBe('failed');
    expect(res.body.note).toContain(`The copy in channel ${C} of the notice saying that two machines announced generation 2 was not posted: can't confirm that the notice is in the owner's DMs`);
  });
});

describe("NB24-B-2 / NB24-RUN-5: a returned notice of M's own", () => {
  it("the ordinary create answered with M's tie notice at 2: 502 another message, no 409", async () => {
    rest.on('post', dmCreate, () => ({ id: 'mTie', channel_id: DM, author: { id: BOT }, ...noticeMessage(2, 'M', ['O']) }));
    expect(await post(call)).toEqual({
      status: 502,
      body: { success: false, error: `Discord refused the switch notice to the bot's owner (${ANOTHER}). A machine whose database was the main will not learn from Discord that it was replaced: keep it off, or rejoin it as a live copy, before it starts again.` },
    });
  });

  it("the tie create answered with M's ordinary notice at 2: present true, that notice pinned, the refused note", async () => {
    rest.seed(DM, noticeMessage(1, 'OLD'), true);
    rest.seed(DM, noticeMessage(2, 'O'), true);
    let returned: any = null;
    rest.on('post', dmCreate, () => { returned = rest.seed(DM, noticeMessage(2, 'M')); return returned; });
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ posted: false, present: true, pinned: true, tie: { machines: ['M', 'O'], named: ['M', 'O'] } });
    expect(res.body.error).toContain('The notice for M was already posted.');
    expect(res.body.note).toBe(`The notice saying that two machines announced generation 2 was not posted (${ANOTHER}); the next switch-notice call for generation 2 tries again`);
    expect(rest.pinned.get(DM)!.has(returned.id)).toBe(true);
  });
});

describe('NB24-RUN-1: a pin that was never sent', () => {
  it('step 4, the budget gone after the re-read: the pin note names the budget, no pin sent', async () => {
    let reads = 0;
    rest.on('get', dmRead, () => {
      reads += 1;
      if (reads === 2) { budgetGone(); }
      return undefined;
    });
    const res = await post(call);
    expect(rest.calls.some(c => c.method === 'put')).toBe(false);
    expect(res.body).toMatchObject({ success: true, posted: true, pinned: false });
    expect(res.body.note).toBe(`Posted, but not pinned (${BUDGET}); ${PIN_LATER}`);
  });

  it('step 3, the budget gone after the tie create: the pin note names the budget', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.on('post', dmCreate, (c: any) => {
      const m = rest.seed(DM, { embeds: c.options.body.embeds });
      budgetGone();
      return m;
    });
    const res = await post(call);
    expect(res.status).toBe(409);
    expect(rest.calls.some(c => c.method === 'put')).toBe(false);
    expect(res.body).toMatchObject({ posted: true, present: true, pinned: false });
    expect(res.body.note).toBe(`Posted, but not pinned (${BUDGET}); ${PIN_LATER}`);
  });
});

describe('NB24-RUN-2: an ordinary create that was never sent', () => {
  it('the budget gone when the create is due: 502 not sent, no refusal claimed, no unknown', async () => {
    rest.fail('put', /^\/channels\/999999999999999999\//, discordError(404, 10008, 'Unknown Message'));
    let once = false;
    rest.on('get', dmRead, async () => {
      if (!once) {
        once = true;
        await pinMessage('999999999999999999', 'gone', Date.now() + 1_000);
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
    expect(res.body.error).not.toContain('refused');
  });
});

describe('NB24-RUN-3: the tie copy is posted once per process when the channel shows none', () => {
  it('a channel that reads empty: a repeat after the nonce window posts no second tie copy, channel already', async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.on('get', channelRead, () => []);
    const first = await post(call);
    expect(first.body.channel).toBe('posted');
    expect(rest.creates(C)).toHaveLength(1);
    expect(rest.creates(C)[0].options.body.nonce).toBe(hashNonce(JSON.stringify(['copy', C, 2, 'M', 'tie'])));
    rest.expireNonces();
    const again = await post({ ...call, repeat: true });
    expect(again.status).toBe(409);
    expect(again.body.channel).toBe('already');
    expect(again.body.note).toBe(memoryNote);
    expect(ownerChannelState().lastRefusal).toBeNull();
    expect(rest.creates(C)).toHaveLength(1);
    expect(rest.creates(DM).filter(c => isTie(c.options.body))).toHaveLength(1);
  });

  it('a first send whose channel read succeeds and finds no copy posts it again', async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    expect((await post(call)).body.channel).toBe('posted');
    rest.messages.set(C, []);
    rest.expireNonces();
    expect((await post(call)).body.channel).toBe('posted');
    expect(rest.creates(C)).toHaveLength(2);
  });
});
