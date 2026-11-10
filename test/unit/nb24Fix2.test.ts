import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { hashNonce, noticeEmbed, readNoticesIn } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel, ownerChannelState } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest } from '../helpers/fakeOwnerRest';

// NB24 code review round 2: regression tests of the fixer's changes.

const TOKEN = 'nb24-fix2-token';
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

const noticeMessage = (generation: number, machine: string) => ({ embeds: [noticeEmbed({ machine, generation, date: DATE })] });
const tieCopyNonce = hashNonce(JSON.stringify(['copy', C, 2, 'M', 'tie']));
const dmRead = new RegExp(`^/channels/${DM}/messages$`);
const call = { machine: 'M', generation: 2, date: DATE };
const memoryNote = `can't confirm that the copy in channel ${C} of the notice saying that two machines announced generation 2 is still there: the channel shows the bot no messages (it may lack Read Message History there); this web UI process posted it earlier and did not post it again`;

function budgetGone(): void {
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
}

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/switch-notice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
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

describe('NB24-C2-1 / C2-T1: the tie copy memory answers only when the channel read shows nothing', () => {
  it("M's tie copy deleted from a channel that still holds other messages: a repeat posts it again, channel posted", async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.seed(C, { content: 'unrelated chat', author: { id: '700000000000000001' } });
    expect((await post(call)).body.channel).toBe('posted');
    rest.messages.set(C, rest.messages.get(C)!.filter(m => m.nonce !== tieCopyNonce));
    rest.expireNonces();
    const again = await post({ ...call, repeat: true });
    expect(again.status).toBe(409);
    expect(again.body.channel).toBe('posted');
    expect(rest.creates(C).map(c => c.options.body.nonce)).toEqual([tieCopyNonce, tieCopyNonce]);
  });

  it('a channel that reads empty: a repeat still answers already from the memory and posts no second copy', async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.on('get', new RegExp(`^/channels/${C}/messages$`), () => []);
    expect((await post(call)).body.channel).toBe('posted');
    rest.expireNonces();
    const again = await post({ ...call, repeat: true });
    expect(again.body.channel).toBe('already');
    expect(again.body.note).toBe(memoryNote);
    expect(ownerChannelState().lastRefusal).toBeNull();
    expect(rest.creates(C)).toHaveLength(1);
  });

  it('readNoticesIn counts every message read, notices or not', async () => {
    rest.seed(C, { content: 'chat', author: { id: '700000000000000001' } });
    rest.seed(C, noticeMessage(2, 'M'));
    const read = await readNoticesIn({ kind: 'channel', id: C }, Date.now() + 5_000);
    if (!read.ok) throw new Error('read failed');
    expect(read.messages).toBe(2);
    expect(read.found).toHaveLength(1);
  });
});

describe('NB24-R2-RUN-1: a repeat whose first read found the budget gone', () => {
  it('answers 503 with the budget cause, and no messages request is sent', async () => {
    answers = [main(2, 'M', C)];
    rest.seed(DM, noticeMessage(1, 'OLD'), true);
    rest.on('get', /\/messages\/pins$/, () => { budgetGone(); return undefined; });
    rest.expireNonces();
    expect(await post({ ...call, repeat: true })).toEqual({
      status: 503, body: { success: false, error: `The switch notices could not be read (${BUDGET}); nothing was posted` },
    });
    expect(rest.calls.some(c => c.method === 'get' && dmRead.test(c.route))).toBe(false);
    expect(rest.creates()).toHaveLength(0);
  });
});
