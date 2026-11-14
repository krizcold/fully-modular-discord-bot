import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { FakeOwnerRest } from '../helpers/fakeOwnerRest';

const TOKEN = 'rt6-token';
const A = 'postgres://bot:pw@a.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
const BAD = 'machine must be 1 to 256 characters, generation a whole number of at least 1, date an ISO 8601 UTC time ending in Z, and repeat, when given, true or false';
const FILE_BOT = 'This bot keeps its data in files, so it has no main database';
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;

const mainAnswer = (): ProbeAnswer => {
  const [e] = parseAddressList(A);
  return {
    kind: 'answered', address: e.shown, entry: A, inRecovery: false, readOnly: false, generation: 2, machine: 'M', since: DATE,
    sysid: 'sys-a', started: 'start-a', storeId: 'store-1', ownerChannel: { kind: 'none' },
  } as ProbeAnswer;
};

beforeAll(async () => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  app = await startApp(a => a.use('/api/managed', createManagedRoutes({} as BotManager)));
});
afterAll(async () => {
  await app.close();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  setBackendKind(null);
});
beforeEach(() => {
  rest = new FakeOwnerRest(5_000);
  _setManagedTiming({ notifyMs: 600, switchMs: 900 });
  _resetOwnerChannel();
  _resetWebuiChoice();
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(A),
    probe: async () => [mainAnswer()],
    readNotice: async () => ({ kind: 'none' }),
    markerStoreId: () => 'store-1',
    noticeCheckOff: () => false,
  });
  setBackendKind('file');
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
    signal: AbortSignal.timeout(1_500),
  });
  return { status: res.status, body: await res.json() };
}

const ok = { machine: 'M', generation: 2, date: DATE };

describe('switch-notice: the checks of the body (a file bot answers 409 to a valid one)', () => {
  it.each([
    ['a machine that is a number', { ...ok, machine: 123 }],
    ['a generation in an array', { ...ok, generation: [7] }],
    ['a generation true', { ...ok, generation: true }],
    ['a generation "+5"', { ...ok, generation: '+5' }],
    ['a generation "5 "', { ...ok, generation: '5 ' }],
    ['a date that is a number', { ...ok, date: 5 }],
    ['a date in an array', { ...ok, date: ['2026-11-05T12:00:00.000Z'] }],
  ])('400 for %s', async (_name, body) => {
    expect(await post(body)).toEqual({ status: 400, body: { success: false, error: BAD } });
    expect(rest.calls).toHaveLength(0);
  });

  it.each([
    ['a machine of 256 characters', { ...ok, machine: 'm'.repeat(256) }],
    ['a machine of 1 character', { ...ok, machine: 'm' }],
    ['a generation of 1', { ...ok, generation: 1 }],
    ['a generation "1"', { ...ok, generation: '1' }],
    ['a generation "12"', { ...ok, generation: '12' }],
  ])('%s passes the checks', async (_name, body) => {
    expect(await post(body)).toEqual({ status: 409, body: { success: false, error: FILE_BOT } });
  });
});

describe('switch-notice: one at a time', () => {
  it('a notice waiting behind one that still holds the line answers 503 busy at its own deadline and posts nothing', async () => {
    setBackendKind('postgres');
    rest.hang('post', /^\/channels\/\d+\/messages$/);
    const first = post(ok);
    await vi.waitFor(() => expect(rest.creates()).toHaveLength(1), { timeout: 1_000, interval: 5 });
    _setManagedTiming({ notifyMs: 600, switchMs: 150 });
    const started = Date.now();
    const second = await post({ ...ok, machine: 'N' });
    expect(second).toEqual({ status: 503, body: { success: false, error: 'Another switch notice is still being posted; try again' } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(rest.creates()).toHaveLength(1);
    expect((await first).body.unknown).toBe(true);
  });
});
