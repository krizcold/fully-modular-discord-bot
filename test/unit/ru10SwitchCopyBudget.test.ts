import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { hashNonce, noticeEmbed } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest } from '../helpers/fakeOwnerRest';

const TOKEN = 'ru10-budget-token';
const C = '500000000000000002';
const A = 'postgres://bot:pw@a.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
const SWITCH_MS = 900;
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
const dmRead = new RegExp(`^/channels/${DM}/messages$`);
const call = { machine: 'M', generation: 2, date: DATE };
const tieNonce = hashNonce(JSON.stringify(['copy', C, 2, 'M', 'tie']));
const budgetNote = `The notice is in the owner's DMs, but its copy in channel ${C} was not posted (the route's budget of 25 s ran out)`;
const channelCalls = () => rest.calls.filter(c => c.route.startsWith(`/channels/${C}/`));

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
  _setManagedTiming({ notifyMs: 600, switchMs: SWITCH_MS });
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

async function firstCallPostsTieCopy(): Promise<void> {
  rest.seed(DM, noticeMessage(2, 'O'), true);
  const first = await post(call);
  expect(first.status).toBe(409);
  expect(first.body.channel).toBe('posted');
  const stored = rest.messages.get(C) ?? [];
  expect(stored).toHaveLength(1);
  expect(stored[0].nonce).toBe(tieNonce);
  rest.calls = [];
}

/** Call 2 with the clock frozen at its arrival; the DM read moves it to `afterRead(arrival)`. */
async function secondCallWithClock(afterRead: (arrival: number) => number): Promise<{ status: number; body: any }> {
  const realNow = Date.now;
  const arrival = realNow.call(Date);
  let now = arrival;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  rest.on('get', dmRead, () => { now = afterRead(arrival); return undefined; });
  try {
    return await post(call);
  } finally {
    spy.mockRestore();
  }
}

describe('ru10: the tie copy step once the route budget is used up', () => {
  it('a budget that ran out during the DM read answers failed with the budget note and touches no channel', async () => {
    await firstCallPostsTieCopy();
    const again = await secondCallWithClock(arrival => arrival + SWITCH_MS + 10_000);
    expect(again.status).toBe(409);
    expect(again.body.channel).toBe('failed');
    expect(again.body.note).toBe(budgetNote);
    expect(again.body.note).not.toContain("can't confirm that the copy");
    expect(channelCalls()).toEqual([]);
    expect(rest.messages.get(C)).toHaveLength(1);
  });

  it('a clock exactly at the deadline after the DM read answers failed with the budget note', async () => {
    await firstCallPostsTieCopy();
    const again = await secondCallWithClock(arrival => arrival + SWITCH_MS);
    expect(again.status).toBe(409);
    expect(again.body.channel).toBe('failed');
    expect(again.body.note).toBe(budgetNote);
    expect(channelCalls()).toEqual([]);
    expect(rest.messages.get(C)).toHaveLength(1);
  });
});
