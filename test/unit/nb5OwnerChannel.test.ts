import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB5 section 8 test 17 (decision 23): the owner channel setting's GET and PUT on the setup routes, over a fake REST,
// a fake prober (the web UI's own choice and chooseNow()), a fake reader row and a spy on shortLivedClient.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const pg = vi.hoisted(() => ({
  configs: [] as any[],
  statements: [] as Array<{ text: string; values?: unknown[] }>,
  ended: 0,
  connect: null as null | (() => Promise<unknown>),
  query: null as null | ((text: string) => Promise<unknown>),
}));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/pgClient')>();
  return {
    ...real,
    shortLivedClient: (config: any) => {
      pg.configs.push(config);
      return {
        connect: () => (pg.connect ? pg.connect() : Promise.resolve()),
        query: (text: string, values?: unknown[]) => {
          pg.statements.push({ text, values });
          return pg.query ? pg.query(text) : Promise.resolve({ rows: [], rowCount: 1 });
        },
        end: async () => { pg.ended++; },
        on: () => undefined,
      };
    },
  };
});

import { BotManager } from '../../src/webui/botManager';
import { createSetupRoutes } from '../../src/webui/routes/setup';
import {
  _resetOwnerChannel, _setOwnerChannelDeps, noteChannelPosted, noteChannelRefusal,
} from '../../src/webui/utils/ownerChannel';
import { _resetWebuiChoice, _setWebuiChoiceDeps, resolveWebuiDatabase, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { dataPath } from '../../src/utils/dataRoot';
import type { NoticeRead, ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { FakeOwnerRest, discordError, DM, httpError, networkError } from '../helpers/fakeOwnerRest';
import { forks, forkLogin } from '../helpers/forkMock';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, PG_URL, freshJsonBot, readJson, serviceFor, useDatabaseUrl } from '../helpers/migrationRig';

const C = '500000000000000001';
const A = 'postgres://bot:pw@a.example:5432/bot';
const W = 'postgres://bot:pw@w.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
const FILE = dataPath('owner-channel.json');
const TEST_POST = "Owner messages from this bot's Bot Manager will be posted here, with a copy of each switch notice; the switch notices themselves stay in the owner's DMs.";
const CANT_USE = (reason: string) => `The setting is kept in the bot's main database, which the web panel cannot use now (${reason}); nothing was changed`;
const CONFIRMING = (reason: string) => `The setting is kept in the bot's main database, which the bot process is still confirming (${reason}); nothing was changed`;
const PREFIX = `The test message was posted in channel ${C}, but the setting was not saved: `;
const SAVED_ID = `Owner messages go to channel ${C} from now on; switch notices also stay in the owner's DMs.`;
const SAVED_NONE = "Owner messages go to the owner's DMs from now on.";
const UPSERT = /^INSERT INTO smdb_data\.meta/;

function answered(entry: string, generation: number, machine: string | null): ProbeAnswer {
  const [e] = parseAddressList(entry);
  return {
    kind: 'answered', address: e.shown, entry, inRecovery: false, readOnly: false, generation, machine, since: DATE,
    sysid: `sys-${entry}`, started: `start-${entry}`, storeId: 'store-1', ownerChannel: { kind: 'none' },
  } as ProbeAnswer;
}

const fake = {
  answers: [] as ProbeAnswer[],
  notice: { kind: 'none' } as NoticeRead,
  probeHook: null as null | (() => Promise<void> | void),
  row: null as unknown,
  rowRefusal: null as Error | null,
};
let rest: FakeOwnerRest;
let manager: BotManager;
let app: { url: string; close: () => Promise<void> };

beforeEach(async () => {
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forkLogin.on = true;
  pg.configs.length = 0;
  pg.statements.length = 0;
  pg.ended = 0;
  pg.connect = null;
  pg.query = null;
  Object.assign(fake, { answers: [answered(A, 1, 'M')], notice: { kind: 'none' }, probeHook: null, row: null, rowRefusal: null });
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  rest = new FakeOwnerRest(300);
  _resetOwnerChannel();
  _resetWebuiChoice();
  setWebuiDataStoreUrl(null);
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(`${A},${W}`),
    probe: async () => { await fake.probeHook?.(); return fake.answers; },
    readNotice: async () => fake.notice,
    markerStoreId: () => 'store-1',
    noticeCheckOff: () => false,
  });
  _setOwnerChannelDeps({
    readRow: async () => { if (fake.rowRefusal) throw fake.rowRefusal; return fake.row; },
    readMs: 150,
    markAfterConnectMs: 200,
  });
  setBackendKind('postgres');
  fs.rmSync(FILE, { force: true });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  manager = new BotManager();
  app = await startApp(a => a.use('/api/setup', createSetupRoutes(manager)));
});
afterEach(async () => {
  await app.close();
  await manager.shutdown(true).catch(() => undefined);
  FakeOwnerRest.reset();
  _setWebuiChoiceDeps(null);
  _setOwnerChannelDeps(null);
  setWebuiDataStoreUrl(null);
  vi.restoreAllMocks();
});

async function put(channelId: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/setup/owner-channel`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(channelId === undefined ? {} : { channelId }),
  });
  return { status: res.status, body: await res.json() };
}

async function get(): Promise<any> {
  return (await fetch(`${app.url}/api/setup/owner-channel`)).json();
}

/** The own choice's first result, so the first check has one. */
async function primeOwnChoice(): Promise<void> {
  resolveWebuiDatabase();
  await vi.waitFor(() => expect(resolveWebuiDatabase()).not.toEqual({ refusal: 'choosing the main database' }));
}

/** Holds the test post until released, running a step first. */
function holdTestPost(during: () => void | Promise<void>): void {
  rest.on('post', new RegExp(`^/channels/${C}/messages$`), async () => { await during(); return undefined; });
}

const writes = () => pg.statements.filter(s => UPSERT.test(s.text) || /^DELETE FROM smdb_data\.meta/.test(s.text));

describe('decision 23: PUT checks and the test post', () => {
  it.each([['12'], ['abc'], [123456789012345678], [undefined]])('400 for %j, nothing posted', async value => {
    expect(await put(value)).toEqual({ status: 400, body: { success: false, error: 'Enter a channel ID (17 to 20 digits), or clear the field to use the owner\'s DMs' } });
    expect(rest.calls).toHaveLength(0);
  });

  it('a refused resolution answers 503 with the reason and posts nothing', async () => {
    await manager.start();
    forks.children[0].emit('message', { type: 'data:store', data: { url: null, choosing: true, reason: 'R' } });
    expect(await put(C)).toEqual({ status: 503, body: { success: false, error: CANT_USE('R') } });
    expect(rest.calls).toHaveLength(0);
  });

  it('an id writes one upsert on one short-lived session to the chosen entry and answers the note', async () => {
    await primeOwnChoice();
    const res = await put(C);
    expect(res).toEqual({ status: 200, body: { success: true, channelId: C, note: SAVED_ID } });
    expect(rest.creates(C)[0].options.body.content).toBe(TEST_POST);
    expect(pg.configs).toHaveLength(1);
    expect(pg.configs[0]).toMatchObject({ host: 'a.example', application_name: 'smdb-webui-setting', connectionTimeoutMillis: 5000, query_timeout: 5000 });
    expect(pg.configs[0].options).toContain('-c statement_timeout=5000');
    expect(pg.configs[0].options).toContain('-c idle_session_timeout=5000');
    expect(writes()).toHaveLength(1);
    expect(writes()[0].values).toEqual([JSON.stringify(C)]);
    expect(pg.ended).toBe(1);
    expect(manager.ownerChannelWriteSettled()).toBe(true);
  });

  it.each([
    [10003, 404, 'Unknown Channel', 'the channel does not exist, or the bot is not in its server'],
    [0, 404, 'Not Found', 'the channel does not exist, or the bot is not in its server'],
    [50001, 403, 'Missing Access', 'the bot cannot see that channel'],
    [50013, 403, 'Missing Permissions', 'the bot lacks the Send Messages permission there'],
    [50035, 400, 'Invalid Form Body', 'Discord answered 50035 Invalid Form Body'],
  ])('the test post refused with %i answers 400 with the cause and writes nothing', async (code, status, message, cause) => {
    await primeOwnChoice();
    rest.fail('post', new RegExp(`^/channels/${C}/messages$`), discordError(status, code, message));
    expect(await put(C)).toEqual({ status: 400, body: { success: false, error: `The bot cannot post in channel ${C}: ${cause}; nothing was changed` } });
    expect(writes()).toHaveLength(0);
  });

  it('a test post answered with a message in another channel answers 400 and writes nothing', async () => {
    await primeOwnChoice();
    rest.on('post', new RegExp(`^/channels/${C}/messages$`), () => ({ id: 'x', channel_id: DM }));
    expect(await put(C)).toEqual({ status: 400, body: { success: false, error: `The bot cannot post in channel ${C}: Discord answered with a message in another channel; nothing was changed` } });
    expect(writes()).toHaveLength(0);
  });

  it("a test post that never answers answers 502 can't confirm and writes nothing", async () => {
    await primeOwnChoice();
    rest.hang('post', new RegExp(`^/channels/${C}/messages$`));
    expect(await put(C)).toEqual({ status: 502, body: { success: false, unknown: true, error: "can't confirm whether the test message was posted: Discord did not answer within 10 s; nothing was changed" } });
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['a network error', () => networkError(), 'a network error (fetch failed)'],
    ['a 502', () => httpError(502, 'Bad Gateway'), 'HTTP 502 (Bad Gateway)'],
  ])("D3: a test post failing with %s answers 502 can't confirm, keeps no refusal and writes nothing", async (_name, error, cause) => {
    await primeOwnChoice();
    rest.fail('post', new RegExp(`^/channels/${C}/messages$`), error());
    expect(await put(C)).toEqual({ status: 502, body: { success: false, unknown: true, error: `can't confirm whether the test message was posted: ${cause}; nothing was changed` } });
    expect(writes()).toHaveLength(0);
    expect((await get()).lastRefusal).toBeNull();
  });

  it('a write answered with an error answers 502 not saved', async () => {
    await primeOwnChoice();
    pg.query = async () => { throw Object.assign(new Error('permission denied for table meta'), { code: '42501', severity: 'ERROR' }); };
    expect(await put(C)).toEqual({ status: 502, body: { success: false, error: 'The setting was not saved (SQLSTATE 42501: permission denied for table meta); owner messages still go where they went before' } });
    expect(manager.ownerChannelWriteSettled()).toBe(true);
  });

  it("a write cut at its bound answers 502 can't confirm; the mark stays until 10 s after the connect", async () => {
    await primeOwnChoice();
    pg.query = async () => { throw new Error('Query read timeout'); };
    expect(await put(C)).toEqual({ status: 502, body: { success: false, unknown: true, error: "can't confirm whether the setting was saved (Query read timeout); reload the page to see where owner messages go" } });
    expect(manager.ownerChannelWriteSettled()).toBe(false);
    await vi.waitFor(() => expect(manager.ownerChannelWriteSettled()).toBe(true));
  });

  it('a migration posted while that mark is set (7 s of the 10 s, scaled) waits at S3 until the mark clears', async () => {
    await primeOwnChoice();
    pg.query = async () => { throw new Error('Query read timeout'); };
    expect((await put(C)).status).toBe(502);
    const marked = Date.now();
    setBackendKind(null);
    freshJsonBot();
    useDatabaseUrl(PG_URL);
    const seen: Array<{ settled: boolean; at: number }> = [];
    const host = new FakeHost();
    host.ownerChannelWriteSettled = () => {
      const settled = manager.ownerChannelWriteSettled();
      seen.push({ settled, at: Date.now() });
      return settled;
    };
    const db = new FakeDb();
    const service = serviceFor(db, host, { ownerChannelWaitMs: 2000 });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 140 - (Date.now() - marked))));
    const posted = await service.post({ jobId: 'job-nb5-late-0001', to: 'postgres' });
    expect(posted.body.success).toBe(true);
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0].settled).toBe(false);
    expect(readJson(JOURNAL).stage).toBe('draining');
    expect(db.schemas.has('smdb_data')).toBe(false);
    await service.idle();
    expect(service.status().body.job.state).toBe('done');
    const firstSettled = seen.findIndex(s => s.settled);
    expect(firstSettled).toBeGreaterThan(0);
    expect(seen.slice(firstSettled + 1)).toEqual([]);
    delete process.env.DATA_BACKEND_URL;
  });

  it.each([
    ['a connect refused', Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }), 'connect ECONNREFUSED 10.0.0.5:5432'],
    ['FATAL 42704 at startup', Object.assign(new Error('unrecognized configuration parameter "idle_session_timeout"'), { code: '42704', severity: 'FATAL' }), 'SQLSTATE 42704: unrecognized configuration parameter "idle_session_timeout"'],
  ])('%s answers 502 not saved and clears the mark at once', async (_n, error, cause) => {
    await primeOwnChoice();
    pg.connect = async () => { throw error; };
    expect(await put(C)).toEqual({ status: 502, body: { success: false, error: `The setting was not saved (${cause}); owner messages still go where they went before` } });
    expect(manager.ownerChannelWriteSettled()).toBe(true);
  });

  it('null deletes the row with no Discord request and answers the DM note', async () => {
    expect(await put(null)).toEqual({ status: 200, body: { success: true, channelId: null, note: SAVED_NONE } });
    expect(rest.calls).toHaveLength(0);
    expect(writes().map(s => s.text)).toEqual(["DELETE FROM smdb_data.meta WHERE key = 'owner_channel'"]);
  });

  it('on a JSON bot the same steps write and remove /data/owner-channel.json', async () => {
    setBackendKind('file');
    expect((await put(C)).body).toEqual({ success: true, channelId: C, note: SAVED_ID });
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual({ channelId: C });
    expect((await put(null)).body).toEqual({ success: true, channelId: null, note: SAVED_NONE });
    expect(fs.existsSync(FILE)).toBe(false);
    expect(pg.configs).toHaveLength(0);
  });

  it('two PUTs at once run one after the other', async () => {
    setBackendKind('file');
    let inFlight = 0;
    let most = 0;
    rest.on('post', /^\/channels\/\d+\/messages$/, async () => {
      most = Math.max(most, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 30));
      inFlight--;
      return undefined;
    });
    const answers = await Promise.all([put(C), put('500000000000000002')]);
    expect(answers.map(a => a.status)).toEqual([200, 200]);
    expect(most).toBe(1);
  });

  it('a running migration answers 409 on Postgres and on JSON, posting and writing nothing', async () => {
    manager.takeMigrationLock({ jobId: 'job-nb5-0001', to: 'postgres' });
    const text = 'A data migration is running (migration job-nb5-0001); change the setting once it ends; nothing was changed';
    expect(await put(C)).toEqual({ status: 409, body: { success: false, error: text } });
    setBackendKind('file');
    expect(await put(C)).toEqual({ status: 409, body: { success: false, error: text } });
    expect(rest.calls).toHaveLength(0);
    expect(fs.existsSync(FILE)).toBe(false);
  });
});

describe('decision 23: GET and the kept refusal', () => {
  it('answers the stored id, none, and unreadable for a refused resolution and for a bad value', async () => {
    setWebuiDataStoreUrl({ url: A });
    fake.row = JSON.stringify(C);
    expect(await get()).toEqual({ readable: true, channelId: C, lastRefusal: null });
    fake.row = null;
    expect(await get()).toEqual({ readable: true, channelId: null, lastRefusal: null });
    fake.row = JSON.stringify('123');
    expect(await get()).toEqual({ readable: false, reason: 'the stored value is not a channel ID of 17 to 20 digits' });
    setWebuiDataStoreUrl({ url: null, choosing: true, reason: 'R' });
    expect(await get()).toEqual({ readable: false, reason: 'R' });
  });

  it('carries the last refusal in the chosen channel; a later post there or a new setting drops it', async () => {
    setBackendKind('file');
    fs.writeFileSync(FILE, JSON.stringify({ channelId: C }));
    noteChannelRefusal(C, 'the bot cannot see that channel');
    const body = await get();
    expect(body.lastRefusal).toMatchObject({ text: 'the bot cannot see that channel' });
    expect(typeof body.lastRefusal.at).toBe('string');
    noteChannelPosted(C);
    expect((await get()).lastRefusal).toBeNull();
    noteChannelRefusal(C, 'the bot cannot see that channel');
    await put(null);
    expect((await get()).lastRefusal).toBeNull();
  });
});

describe('decision 23: the gate around the test post (rounds 6 to 8)', () => {
  it('a held report answers 503 still confirming, with no request and no session; GET still answers; after a plain report it saves', async () => {
    await manager.start();
    const child = forks.children[0];
    child.emit('message', { type: 'data:store', data: { url: A, held: true, reason: 'the database did not answer' } });
    fake.row = JSON.stringify(C);
    expect(await put(C)).toEqual({ status: 503, body: { success: false, error: CONFIRMING('the database did not answer') } });
    expect(rest.calls).toHaveLength(0);
    expect(pg.configs).toHaveLength(0);
    expect((await get()).channelId).toBe(C);
    child.emit('message', { type: 'data:store', data: { url: A } });
    expect((await put(C)).status).toBe(200);
  });

  it('a held report arriving during the test post answers 503 with the prefix', async () => {
    await manager.start();
    const child = forks.children[0];
    child.emit('message', { type: 'data:store', data: { url: A } });
    holdTestPost(() => child.emit('message', { type: 'data:store', data: { url: A, held: true, reason: 'H' } }));
    expect(await put(C)).toEqual({ status: 503, body: { success: false, error: PREFIX + CONFIRMING('H') } });
    expect(pg.configs).toHaveLength(0);
  });

  it('a choosing report during the test post answers the first 503 with the prefix', async () => {
    await manager.start();
    const child = forks.children[0];
    child.emit('message', { type: 'data:store', data: { url: A } });
    holdTestPost(() => child.emit('message', { type: 'data:store', data: { url: null, choosing: true, reason: 'R' } }));
    expect(await put(C)).toEqual({ status: 503, body: { success: false, error: PREFIX + CANT_USE('R') } });
  });

  it('a migration taking its lock during the test post answers 409 with the prefix and writes nothing', async () => {
    setBackendKind('file');
    holdTestPost(() => { manager.takeMigrationLock({ jobId: 'job-nb5-0002', to: 'postgres' }); });
    expect(await put(C)).toEqual({ status: 409, body: { success: false, error: `${PREFIX}A data migration is running (migration job-nb5-0002); change the setting once it ends; nothing was changed` } });
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it('a report naming W during the test post, with a fresh choice picking W, writes to W', async () => {
    await manager.start();
    const child = forks.children[0];
    child.emit('message', { type: 'data:store', data: { url: A } });
    holdTestPost(() => {
      child.emit('message', { type: 'data:store', data: { url: W } });
      fake.answers = [answered(A, 1, 'M'), answered(W, 2, 'N')];
    });
    expect((await put(C)).status).toBe(200);
    expect(pg.configs[0]).toMatchObject({ host: 'w.example' });
  });

  it('a migration taking its lock in the same tick as the second check either refuses the PUT or finds the mark', async () => {
    await primeOwnChoice();
    let migrationGotLock = false;
    let markSeen = false;
    fake.probeHook = () => {
      setImmediate(() => {
        migrationGotLock = manager.takeMigrationLock({ jobId: 'job-nb5-0003', to: 'postgres' });
        markSeen = !manager.ownerChannelWriteSettled();
      });
    };
    pg.query = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { rows: [], rowCount: 1 }; };
    const res = await put(C);
    expect(migrationGotLock).toBe(true);
    expect(res.status === 200 && !markSeen).toBe(false);
  });

  it.each([
    ['a held report', (child: any) => child.emit('message', { type: 'data:store', data: { url: A, held: true, reason: 'H' } }), 'the bot process reported its database held (H)'],
    ['a choosing report', (child: any) => child.emit('message', { type: 'data:store', data: { url: null, choosing: true, reason: 'R' } }), 'the bot process began choosing its database (R)'],
    ['a report of W', (child: any) => child.emit('message', { type: 'data:store', data: { url: W } }), 'the bot process moved to w.example:5432/bot'],
  ])('with the write held open, %s turns the answer into 502 unknown naming it', async (_n, change, words) => {
    await manager.start();
    const child = forks.children[0];
    child.emit('message', { type: 'data:store', data: { url: A } });
    pg.query = async () => { change(child); return { rows: [], rowCount: 1 }; };
    expect(await put(C)).toEqual({ status: 502, body: { success: false, unknown: true, error: `The setting was written to a.example:5432/bot, but while it was written ${words}; can't confirm where owner messages go; reload the page once the bot runs` } });
  });

  it('with the write held open, a child exit names the bot process ended', async () => {
    await manager.start();
    const child = forks.children[0];
    child.emit('message', { type: 'data:store', data: { url: A } });
    pg.query = async () => { child.exitCode = 0; child.emit('exit', 0, null); return { rows: [], rowCount: 1 }; };
    expect((await put(C)).body.error).toBe("The setting was written to a.example:5432/bot, but while it was written the bot process ended; can't confirm where owner messages go; reload the page once the bot runs");
  });

  it('with no bot process, a child that starts while the write is on the wire names a bot process started; a maintenance boot then names that', async () => {
    await primeOwnChoice();
    pg.query = async () => { await manager.start(); return { rows: [], rowCount: 1 }; };
    expect((await put(C)).body.error).toBe("The setting was written to a.example:5432/bot, but while it was written a bot process started; can't confirm where owner messages go; reload the page once the bot runs");
    await manager.shutdown();
    await primeOwnChoice();
    pg.query = async () => {
      await manager.start();
      forks.children.at(-1).emit('message', { type: 'maintenance:mode', data: { mode: 'login-refused', boot: true } });
      return { rows: [], rowCount: 1 };
    };
    expect((await put(C)).body.error).toBe("The setting was written to a.example:5432/bot, but while it was written the bot process booted in maintenance; can't confirm where owner messages go; reload the page once the bot runs");
  });

  it('with no bot process: a last result naming A and a fresh choice finding a newer notice answers 503 behind-notice after the test post', async () => {
    await primeOwnChoice();
    fake.notice = { kind: 'notice', generation: 2, machine: 'N', date: DATE };
    const res = await put(C);
    expect(res.status).toBe(503);
    expect(res.body.error.startsWith(PREFIX + "The setting is kept in the bot's main database, which the web panel cannot use now (can't confirm that a.example:5432/bot is the main")).toBe(true);
    expect(writes()).toHaveLength(0);
    _resetWebuiChoice();
    fake.notice = { kind: 'notice', generation: 1, machine: 'M', date: DATE };
    await primeOwnChoice();
    expect((await put(C)).status).toBe(200);
    expect(pg.configs.at(-1)).toMatchObject({ host: 'a.example' });
  });

  it('in confirming, the 503 names the held report reason, not checking', async () => {
    await manager.start();
    const child = forks.children[0];
    child.emit('message', { type: 'data:store', data: { url: A, held: true, reason: 'checking' } });
    child.emit('message', { type: 'data:store', data: { url: A, held: true, reason: 'the switch notices could not be read (HTTP 403 (Missing Access))' } });
    expect((await put(C)).body.error).toBe(CONFIRMING('the switch notices could not be read (HTTP 403 (Missing Access))'));
  });
});

describe('decision 23 round 8: a bot process reporting A, neither choosing nor held', () => {
  async function reportingA(): Promise<any> {
    await manager.start();
    const child = forks.children[0];
    child.emit('message', { type: 'data:store', data: { url: A } });
    return child;
  }

  it.each([[C], [null]])('a fresh choice finding a newer notice answers 503 behind-notice (%s)', async value => {
    await reportingA();
    fake.notice = { kind: 'notice', generation: 2, machine: 'N', date: DATE };
    const res = await put(value);
    expect(res.status).toBe(503);
    const head = (value ? PREFIX : '') + "The setting is kept in the bot's main database, which the web panel cannot use now (can't confirm that a.example:5432/bot is the main";
    expect(res.body.error.startsWith(head)).toBe(true);
    expect(pg.configs).toHaveLength(0);
  });

  it.each([[C], [null]])('a fresh choice picking A writes to A (%s)', async value => {
    await reportingA();
    expect((await put(value)).status).toBe(200);
    expect(pg.configs[0]).toMatchObject({ host: 'a.example' });
  });

  it.each([[C], [null]])('a fresh choice picking W answers 503 with both addresses (%s)', async value => {
    await reportingA();
    fake.answers = [answered(A, 1, 'M'), answered(W, 2, 'N')];
    expect(await put(value)).toEqual({ status: 503, body: { success: false, error: (value ? PREFIX : '') + CANT_USE('a check of the databases made now picks w.example:5432/bot, while the bot process uses a.example:5432/bot') } });
    expect(pg.configs).toHaveLength(0);
  });

  it.each([[C], [null]])('a data:store naming A again during chooseNow answers 503 (%s)', async value => {
    const child = await reportingA();
    fake.probeHook = () => child.emit('message', { type: 'data:store', data: { url: A } });
    expect(await put(value)).toEqual({ status: 503, body: { success: false, error: (value ? PREFIX : '') + CANT_USE('the bot process reported a change of its database during the check') } });
    expect(pg.configs).toHaveLength(0);
  });
});

describe('decision 23 round 8: a child that has not reported', () => {
  it('a child in a normal boot with no data:store answers 503 starting with no test post', async () => {
    await manager.start();
    expect(await put(C)).toEqual({ status: 503, body: { success: false, error: CANT_USE('the bot process is starting; try again once it has started') } });
    expect(rest.calls).toHaveLength(0);
  });

  it('a maintenance-boot child gets the own choice at both checks and writes to its entry', async () => {
    await manager.start();
    forks.children[0].emit('message', { type: 'maintenance:mode', data: { mode: 'login-refused', boot: true } });
    await primeOwnChoice();
    expect((await put(C)).status).toBe(200);
    expect(pg.configs[0]).toMatchObject({ host: 'a.example' });
  });
});
