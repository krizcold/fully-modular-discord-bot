import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { hashNonce, noticeEmbed } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel, ownerChannelState } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest, httpError } from '../helpers/fakeOwnerRest';

// NB24 code review round 3 (NB24-C3-T3): a later call whose channel read fails after the first call's tie copy landed.

const TOKEN = 'nb24-tiecopy-token';
const C = '500000000000000002';
const A = 'postgres://bot:pw@a.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;

function main(generation: number, machine: string, channel: string): ProbeAnswer {
  const [e] = parseAddressList(A);
  return {
    kind: 'answered', address: e.shown, entry: A, inRecovery: false, readOnly: false, generation, machine, since: DATE,
    sysid: 'sys-a', started: 'start-a', storeId: 'store-1', ownerChannel: { kind: 'id', id: channel },
  } as ProbeAnswer;
}

const noticeMessage = (generation: number, machine: string) => ({ embeds: [noticeEmbed({ machine, generation, date: DATE })] });
const channelRead = new RegExp(`^/channels/${C}/messages$`);
const call = { machine: 'M', generation: 2, date: DATE };
const tieNonce = hashNonce(JSON.stringify(['copy', C, 2, 'M', 'tie']));
const unreadNote = (cause: string) => `can't confirm that the copy in channel ${C} of the notice saying that two machines announced generation 2 is still there: the channel could not be read (${cause}); this web UI process posted it earlier and did not post it again`;

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
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(A),
    probe: async () => [main(2, 'M', C)],
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

async function firstCopyThenDeleted(): Promise<void> {
  rest.seed(DM, noticeMessage(2, 'O'), true);
  const first = await post(call);
  expect(first.status).toBe(409);
  expect(first.body.channel).toBe('posted');
  const stored = rest.messages.get(C) ?? [];
  expect(stored).toHaveLength(1);
  expect(stored[0].nonce).toBe(tieNonce);
  expect(stored[0].embeds[0].fields.some((f: any) => f.name === 'Also announced')).toBe(true);
  rest.messages.set(C, []);
  rest.expireNonces();
}

describe('NB24-C3-T3: a channel read that fails on a later call, the channel still open to sends', () => {
  it('a 500 on the read: no second tie copy, already with a can\'t-confirm note naming the channel and the failed read', async () => {
    await firstCopyThenDeleted();
    rest.fail('get', channelRead, httpError(500, 'Internal Server Error'));
    const again = await post(call);
    expect(again.status).toBe(409);
    expect(again.body.channel).toBe('already');
    expect(rest.creates(C)).toHaveLength(1);
    expect(rest.messages.get(C)).toEqual([]);
    expect(again.body.note).toBe(unreadNote('HTTP 500 (Internal Server Error)'));
    expect(ownerChannelState().lastRefusal).toBeNull();
  });

  it('a read that hangs to the bound: no second tie copy, already with the can\'t-confirm note', async () => {
    await firstCopyThenDeleted();
    rest.hang('get', channelRead);
    const again = await post(call);
    expect(again.status).toBe(409);
    expect(again.body.channel).toBe('already');
    expect(rest.creates(C)).toHaveLength(1);
    expect(rest.messages.get(C)).toEqual([]);
    expect(rest.calls.some(c => c.method === 'get' && channelRead.test(c.route) && c.aborted)).toBe(true);
    expect(again.body.note).toBe(unreadNote('a timeout'));
  });

  it('a first call whose channel read fails with a 500 posts the tie copy once, with no can\'t-confirm note', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.fail('get', channelRead, httpError(500, 'Internal Server Error'));
    const first = await post(call);
    expect(first.status).toBe(409);
    expect(first.body.channel).toBe('posted');
    expect(rest.calls.some(c => c.method === 'get' && channelRead.test(c.route))).toBe(true);
    expect(rest.creates(C)).toHaveLength(1);
    const stored = rest.messages.get(C) ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0].nonce).toBe(tieNonce);
    expect(stored[0].embeds[0].fields.some((f: any) => f.name === 'Also announced')).toBe(true);
    expect(first.body.note ?? '').not.toContain("can't confirm that the copy");
    expect(ownerChannelState().lastRefusal).toBeNull();
  });
});
