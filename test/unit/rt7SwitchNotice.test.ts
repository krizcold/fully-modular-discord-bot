import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { NOTICE_TITLE } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel, noteChannelRefusal, ownerChannelState } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest, discordError } from '../helpers/fakeOwnerRest';

const TOKEN = 'rt7-token';
const C = '500000000000000007';
const A = 'postgres://bot:pw@a.example:5432/bot';
const W = 'postgres://bot:pw@w.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;
let answers: ProbeAnswer[] = [];

function main(entry: string, generation: number, machine: string | null, extra: Partial<ProbeAnswer> = {}): ProbeAnswer {
  const [e] = parseAddressList(entry);
  return {
    kind: 'answered', address: e.shown, entry, inRecovery: false, readOnly: false, generation, machine, since: DATE,
    sysid: `sys-${entry}`, started: `start-${entry}`, storeId: 'store-1', ownerChannel: { kind: 'none' }, ...extra,
  } as ProbeAnswer;
}

function noticeMessage(generation: number, machine: string) {
  return { embeds: [{ title: NOTICE_TITLE, timestamp: DATE, fields: [{ name: 'Machine', value: machine }, { name: 'Generation', value: String(generation) }] }] };
}

function setDeps(): void {
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(`${A},${W}`),
    probe: async () => answers,
    readNotice: async () => ({ kind: 'none' }),
    markerStoreId: () => 'store-1',
    noticeCheckOff: () => false,
  });
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
  answers = [main(A, 2, 'M')];
  setDeps();
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

const ok = { machine: 'M', generation: 2, date: DATE };

describe('rt7: switch-notice answers before any post', () => {
  it('an invalid body answers 400 with success false and the whole rule', async () => {
    expect(await post({ ...ok, machine: '' })).toEqual({
      status: 400,
      body: { success: false, error: 'machine must be 1 to 256 characters, generation a whole number of at least 1, date an ISO 8601 UTC time ending in Z, and repeat, when given, true or false' },
    });
    expect(rest.calls).toHaveLength(0);
  });

  it("a tie answers 409 with success false and can't confirm", async () => {
    answers = [main(A, 2, 'M'), main(W, 2, 'N')];
    const res = await post(ok);
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/^can't confirm the main database: Two databases accept writes at main generation 2: .+; no notice was posted$/);
    expect(rest.creates()).toHaveLength(0);
  });

  it('a main that names no machine is shown as no machine named', async () => {
    answers = [main(A, 2, null)];
    expect(await post(ok)).toEqual({
      status: 409,
      body: { success: false, error: 'The databases this bot reaches hold generation 2 (no machine named) as the main, not 2 (M); no notice was posted' },
    });
    expect(rest.creates()).toHaveLength(0);
  });

  it('a budget that ends exactly at the DM create answers the lapsed 503 and sends nothing', async () => {
    _setManagedTiming({ switchMs: 0 });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const res = await post(ok);
    expect(res).toEqual({ status: 503, body: { success: false, error: 'This switch notice waited for an earlier one and ran out of time; nothing was posted; try again' } });
    expect(rest.calls).toHaveLength(0);
  });
});

describe("rt7: the chosen channel comes from the chosen database's answer", () => {
  it('an earlier answered database below the main does not lend its channel setting', async () => {
    answers = [main(W, 1, 'M'), main(A, 2, 'M', { ownerChannel: { kind: 'id', id: C } })];
    const res = await post(ok);
    expect(res.body).toEqual({ success: true, posted: true, pinned: true, channel: 'posted' });
    expect(rest.creates(C)).toHaveLength(1);
  });

  it('a failed answer for the same entry is not taken as the main', async () => {
    const [e] = parseAddressList(A);
    answers = [
      { kind: 'failed', address: e.shown, entry: A, cause: 'a timeout' } as ProbeAnswer,
      main(A, 2, 'M', { ownerChannel: { kind: 'id', id: C } }),
    ];
    const res = await post(ok);
    expect(res.body).toEqual({ success: true, posted: true, pinned: true, channel: 'posted' });
    expect(rest.creates(C)).toHaveLength(1);
  });
});

describe('rt7: a notice already in the DMs', () => {
  it('an already pinned notice is not pinned again', async () => {
    rest.seed(DM, noticeMessage(2, 'M'), true);
    const res = await post(ok);
    expect(res.body).toEqual({ success: true, posted: false, channel: 'none', note: 'A switch notice of generation 2 (M) is already posted; this one was not posted.' });
    expect(rest.calls.filter(c => c.method === 'put')).toHaveLength(0);
  });

  it('an unreadable channel setting answers channel failed, its note joined to the first by one space', async () => {
    answers = [main(A, 2, 'M', { ownerChannel: { kind: 'unreadable', cause: 'the setting row could not be read' } })];
    rest.seed(DM, noticeMessage(3, 'N'), true);
    const res = await post(ok);
    expect(res.body).toEqual({
      success: true, posted: false, newer: { generation: 3, machines: ['N'] }, channel: 'failed',
      note: "A switch notice of generation 3 (N) is already posted; this one was not posted. The notice is in the owner's DMs, but its copy in the chosen channel was not posted (the setting row could not be read)",
    });
    expect(rest.creates()).toHaveLength(0);
  });
});

describe('rt7: the copy in the chosen channel', () => {
  beforeEach(() => { answers = [main(A, 2, 'M', { ownerChannel: { kind: 'id', id: C } })]; });

  it('the budget gone before the copy names the 25 s budget in the note', async () => {
    _setManagedTiming({ switchMs: 300 });
    rest.on('put', /\/messages\/pins\//, async () => { await new Promise(resolve => setTimeout(resolve, 350)); return undefined; });
    const res = await post(ok);
    expect(res.body).toEqual({
      success: true, posted: true, pinned: true, channel: 'failed',
      note: `The notice is in the owner's DMs, but its copy in channel ${C} was not posted (the route's budget of 25 s ran out)`,
    });
    expect(rest.creates(C)).toHaveLength(0);
  });

  it("a copy create that times out answers can't confirm and keeps no refusal", async () => {
    rest = new FakeOwnerRest(100);
    rest.hang('post', new RegExp(`^/channels/${C}/messages$`));
    const res = await post(ok);
    expect(res.body).toEqual({
      success: true, posted: true, pinned: true, channel: 'failed',
      note: `can't confirm whether the copy in channel ${C} was posted: Discord did not answer in time`,
    });
    expect(ownerChannelState().lastRefusal).toBeNull();
  });

  it('a copy refused by Discord keeps the refusal for the channel', async () => {
    rest.fail('post', new RegExp(`^/channels/${C}/messages$`), discordError(403, 50001, 'Missing Access'));
    const res = await post(ok);
    expect(res.body.channel).toBe('failed');
    expect(ownerChannelState().lastRefusal).toMatchObject({ channelId: C, text: 'the bot cannot see that channel' });
  });

  it('a posted copy clears an earlier refusal of the channel', async () => {
    noteChannelRefusal(C, 'an earlier refusal');
    expect(ownerChannelState().lastRefusal).not.toBeNull();
    const res = await post(ok);
    expect(res.body).toEqual({ success: true, posted: true, pinned: true, channel: 'posted' });
    expect(ownerChannelState().lastRefusal).toBeNull();
  });
});
