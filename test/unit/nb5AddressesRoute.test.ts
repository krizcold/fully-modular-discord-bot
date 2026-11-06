import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB5 section 8 test 16 (decision 22) and C2's row (d), on createManagedRoutes over a real BotManager and a fake fork.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn((..._args: unknown[]) => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { fork } from 'child_process';
import { BotManager } from '../../src/webui/botManager';
import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import { addressListInUse, resetAddressesForTests } from '../../src/utils/databaseAddress';
import { _resetWebuiChoice, _setWebuiChoiceDeps, resolveWebuiDatabase } from '../../src/webui/utils/webuiDataReader';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { forks, forkStage } from '../helpers/forkMock';

const TOKEN = 'nb5-token';
const ONE = 'postgres://bot:pw@a.example:5432/bot';
const TWO = 'postgres://bot:pw@a.example:5432/bot,postgres://bot:pw@w.example:5432/bot';
let app: { url: string; close: () => Promise<void> };
let manager: BotManager;
const logs: string[] = [];

beforeAll(async () => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
});
afterAll(async () => {
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
});
beforeEach(async () => {
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forks.onFork = null;
  forkStage.stages = ['shared', 'guild'];
  vi.mocked(fork).mockClear();
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  process.env.DATA_BACKEND_URL = ONE;
  resetAddressesForTests();
  _resetWebuiChoice();
  setBackendKind('postgres');
  _setManagedTiming({ notifyMs: 600, switchMs: 900, addressesAckMs: 300 });
  logs.length = 0;
  const capture = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  manager = new BotManager();
  app = await startApp(a => a.use('/api/managed', createManagedRoutes(manager)));
});
afterEach(async () => {
  await app.close();
  await manager.shutdown(true).catch(() => undefined);
  _setManagedTiming(null);
  _setWebuiChoiceDeps(null);
  delete process.env.DATA_BACKEND_URL;
  resetAddressesForTests();
  vi.restoreAllMocks();
});

async function addresses(body: unknown, token = TOKEN): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/addresses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const sentAddresses = (child: any) => child.send.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.type === 'data:addresses');
const ack = (child: any, data: object) => child.emit('message', { type: 'data:addresses-ack', data });
const forkEnv = (n: number) => (vi.mocked(fork).mock.calls[n] as any[])[2].env;

describe('decision 22: the addresses hook', () => {
  it('needs the manager token', async () => {
    expect((await addresses({ url: TWO }, 'wrong')).status).toBe(403);
  });

  it('400 for a missing url and for an entry that is not postgres', async () => {
    expect((await addresses({})).status).toBe(400);
    expect(await addresses({ url: 'postgresql://a, mysql://b' })).toEqual({ status: 400, body: { success: false, error: 'entry 2 of DATA_BACKEND_URL must start with postgresql:// or postgres://' } });
    expect(addressListInUse()).toBe(ONE);
  });

  it('409 on a file bot', async () => {
    setBackendKind('file');
    expect((await addresses({ url: TWO })).status).toBe(409);
  });

  it('with no bot process the list is taken at once, and the next fork gets it', async () => {
    expect(await addresses({ url: TWO })).toEqual({ status: 200, body: { success: true, applied: true, note: 'No bot process runs; the next one starts with these addresses.' } });
    expect(addressListInUse()).toBe(TWO);
    await manager.start();
    expect(forkEnv(0).DATA_BACKEND_URL).toBe(TWO);
  });

  it('a bot process that acknowledges: applied, and a restart forks with the list; the own choice uses it', async () => {
    await manager.start();
    const child = forks.children[0];
    const answer = addresses({ url: TWO });
    await vi.waitFor(() => expect(sentAddresses(child)).toHaveLength(1));
    const [message] = sentAddresses(child);
    expect(message.data.url).toBe(TWO);
    expect(addressListInUse()).toBe(ONE);
    ack(child, { id: message.data.id, accepted: true });
    expect(await answer).toEqual({ status: 200, body: { success: true, applied: true } });
    expect(addressListInUse()).toBe(TWO);
    await manager.restart();
    expect(forkEnv(1).DATA_BACKEND_URL).toBe(TWO);
    await manager.shutdown();
    const probed: string[][] = [];
    _setWebuiChoiceDeps({
      probe: async entries => { probed.push(entries.map(e => e.raw)); return []; },
      readNotice: async () => ({ kind: 'none' }),
      markerStoreId: () => null,
      noticeCheckOff: () => false,
    });
    resolveWebuiDatabase();
    await vi.waitFor(() => expect(probed).toHaveLength(1));
    expect(probed[0]).toEqual(TWO.split(','));
  });

  it('C2 (d): a child in stage waiting gets the call (no stage refusal) and answers applied on the ack', async () => {
    forkStage.stages = [];
    await manager.start();
    const child = forks.children[0];
    child.emit('message', { type: 'data:writer', data: { stage: 'waiting', holder: { role: 'bot', pid: 1 } } });
    const answer = addresses({ url: TWO });
    await vi.waitFor(() => expect(sentAddresses(child)).toHaveLength(1));
    ack(child, { id: sentAddresses(child)[0].data.id, accepted: true });
    expect((await answer).body).toEqual({ success: true, applied: true });
  });

  it('one that refuses: 400 with its error and the list in use unchanged', async () => {
    await manager.start();
    const child = forks.children[0];
    const answer = addresses({ url: TWO });
    await vi.waitFor(() => expect(sentAddresses(child)).toHaveLength(1));
    ack(child, { id: sentAddresses(child)[0].data.id, accepted: false, error: 'entry 2 of DATA_BACKEND_URL cannot be parsed as a database address' });
    expect(await answer).toEqual({ status: 400, body: { success: false, error: 'entry 2 of DATA_BACKEND_URL cannot be parsed as a database address' } });
    expect(addressListInUse()).toBe(ONE);
  });

  it('one that never answers: 502 unknown at the bound', async () => {
    await manager.start();
    expect(await addresses({ url: TWO })).toEqual({ status: 502, body: { success: false, unknown: true, error: "can't confirm whether the bot process took the new addresses: it did not answer within 5 s; repeat the call" } });
    expect(addressListInUse()).toBe(ONE);
  });

  it('a late accepted ack takes the list and logs the line; the next fork gets it', async () => {
    await manager.start();
    const child = forks.children[0];
    expect((await addresses({ url: TWO })).status).toBe(502);
    ack(child, { id: sentAddresses(child)[0].data.id, accepted: true });
    expect(addressListInUse()).toBe(TWO);
    expect(logs).toContain('[WebUI] The bot process took the address list after the hook answered; later bot processes start with it');
    await manager.restart();
    expect(forkEnv(1).DATA_BACKEND_URL).toBe(TWO);
  });

  it('a late ack for an older id after a newer call changes nothing', async () => {
    await manager.start();
    const child = forks.children[0];
    expect((await addresses({ url: TWO })).status).toBe(502);
    const first = sentAddresses(child)[0].data.id;
    const second = addresses({ url: `${ONE},postgres://bot:pw@x.example:5432/bot` });
    await vi.waitFor(() => expect(sentAddresses(child)).toHaveLength(2));
    ack(child, { id: first, accepted: true });
    expect(addressListInUse()).toBe(ONE);
    ack(child, { id: sentAddresses(child)[1].data.id, accepted: false, error: 'no' });
    expect((await second).status).toBe(400);
    expect(addressListInUse()).toBe(ONE);
  });

  it('writes nothing to /data/.env', async () => {
    await addresses({ url: TWO });
    expect(fs.existsSync(dataPath('.env'))).toBe(false);
  });
});
