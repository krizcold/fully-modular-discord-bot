import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB5 section 8 test 13 (decision 17) and G8's rows: the web UI's database, from the bot process's report, its
// starting refusal, or the web UI process's own choice; chooseNow(); the pools built through pgConfig.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const pools = vi.hoisted(() => ({ configs: [] as any[], ended: 0 }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('pg', async orig => {
  const real = await orig<any>();
  class Pool {
    totalCount = 0;
    idleCount = 0;
    constructor(config: any) { pools.configs.push(config); }
    on() { return this; }
    async query() { return { rows: [] }; }
    async end() { pools.ended++; }
  }
  return { ...real, Pool, default: { ...(real.default ?? real), Pool } };
});

import { BotManager } from '../../src/webui/botManager';
import {
  WebuiDataReader, _resetWebuiChoice, _setWebuiChoiceDeps, chooseNow, noteWebuiChild, resolveWebuiDatabase,
  setWebuiDataStoreUrl, webuiReportCount,
} from '../../src/webui/utils/webuiDataReader';
import { _pgRequestDbForTests, _setGuildRequestDeps, runHolderCheck, switchOnNotHeld, type Plan } from '../../src/webui/utils/guildRequests';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { NoticeRead, ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { MARKER_FILE, writeFileMarker } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { forks, forkLogin } from '../helpers/forkMock';

const A = 'postgres://bot:pw@a.example:5432/bot';
const W = 'postgres://bot:pw@w.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';

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
  probeMs: 0,
  noticeMs: 0,
  probes: 0,
  reads: 0,
  ownReads: 0,
  inFlightProbes: 0,
  overlap: 0,
};

beforeEach(() => {
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forkLogin.on = true;
  pools.configs.length = 0;
  pools.ended = 0;
  Object.assign(fake, { answers: [answered(A, 1, 'M')], notice: { kind: 'none' }, probeMs: 0, noticeMs: 0, probes: 0, reads: 0, ownReads: 0, inFlightProbes: 0, overlap: 0 });
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  _resetWebuiChoice();
  setWebuiDataStoreUrl(null);
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(`${A},${W}`),
    probe: async () => {
      fake.probes++;
      fake.inFlightProbes++;
      if (fake.inFlightProbes > 1) fake.overlap++;
      await new Promise(resolve => setTimeout(resolve, fake.probeMs));
      fake.inFlightProbes--;
      return fake.answers;
    },
    readNotice: async own => {
      fake.reads++;
      if (own) fake.ownReads++;
      await new Promise(resolve => setTimeout(resolve, fake.noticeMs));
      return fake.notice;
    },
    markerStoreId: () => 'store-1',
    noticeCheckOff: () => false,
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  _setWebuiChoiceDeps(null);
  _setGuildRequestDeps(null);
  setWebuiDataStoreUrl(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const store = (child: any, data: object) => child.emit('message', { type: 'data:store', data });
const mode = (child: any, data: object) => child.emit('message', { type: 'maintenance:mode', data });

async function settledOwnChoice(): Promise<ReturnType<typeof resolveWebuiDatabase>> {
  resolveWebuiDatabase();
  let answer = resolveWebuiDatabase();
  await vi.waitFor(() => {
    answer = resolveWebuiDatabase();
    expect(answer).not.toEqual({ refusal: 'choosing the main database' });
  });
  return answer;
}

describe('decision 17: the three cases', () => {
  it('answers the reported entry, for a one-entry and a list env alike', () => {
    setWebuiDataStoreUrl({ url: A });
    expect(resolveWebuiDatabase()).toEqual({ entry: A });
  });

  it('a choosing report refuses with its reason; a report at the latch refuses until the new entry is reported', () => {
    setWebuiDataStoreUrl({ url: A });
    setWebuiDataStoreUrl({ url: null, choosing: true, reason: 'the database at a.example:5432/bot was replaced' });
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'the database at a.example:5432/bot was replaced' });
    setWebuiDataStoreUrl({ url: W });
    expect(resolveWebuiDatabase()).toEqual({ entry: W });
  });

  it('a held report answers the entry with held; a second held report replaces the reason; a later plain report clears it', () => {
    setWebuiDataStoreUrl({ url: A, held: true, reason: 'checking' });
    expect(resolveWebuiDatabase()).toEqual({ entry: A, held: { reason: 'checking' } });
    setWebuiDataStoreUrl({ url: A, held: true, reason: 'the switch notices could not be read (HTTP 403 (Missing Access))' });
    expect(resolveWebuiDatabase()).toEqual({ entry: A, held: { reason: 'the switch notices could not be read (HTTP 403 (Missing Access))' } });
    setWebuiDataStoreUrl({ url: A });
    expect(resolveWebuiDatabase()).toEqual({ entry: A });
  });

  it('with no bot process: choosing the main database before the first result, then the chosen entry', async () => {
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'choosing the main database' });
    expect(await settledOwnChoice()).toEqual({ entry: A });
  });

  it('with no bot process: a one-entry main behind a newer notice refuses with its reason', async () => {
    fake.notice = { kind: 'notice', generation: 2, machine: 'N', date: DATE };
    const answer = await settledOwnChoice();
    expect('refusal' in answer && answer.refusal).toMatch(/^can't confirm that a\.example:5432\/bot is the main: it holds generation 1 \(M\), but generation 2 was announced for N/);
  });

  it('runs the own choice at most once every 10 s', async () => {
    await settledOwnChoice();
    for (let i = 0; i < 5; i++) resolveWebuiDatabase();
    expect(fake.probes).toBe(1);
  });
});

describe('decision 17 on botManager: the report, the starting refusal and the report count', () => {
  it('data:store messages, child start, child exit and a maintenance boot each raise the count', async () => {
    const manager = new BotManager();
    const c0 = webuiReportCount();
    await manager.start();
    const child = forks.children[0];
    const c1 = webuiReportCount();
    expect(c1).toBeGreaterThan(c0);
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'the bot process is starting; try again once it has started' });
    store(child, { url: null, choosing: true, reason: 'R' });
    const c2 = webuiReportCount();
    expect(c2).toBeGreaterThan(c1);
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'R' });
    store(child, { url: A, held: true, reason: 'H' });
    expect(webuiReportCount()).toBeGreaterThan(c2);
    expect(resolveWebuiDatabase()).toEqual({ entry: A, held: { reason: 'H' } });
    const c3 = webuiReportCount();
    await manager.shutdown();
    expect(webuiReportCount()).toBeGreaterThan(c3);
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'choosing the main database' });
  });

  it('a child in a normal boot that sent a login line but no data:store still refuses as starting', async () => {
    const manager = new BotManager();
    await manager.start();
    await vi.waitFor(() => expect((manager as any).childModeReported).toBe(true));
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'the bot process is starting; try again once it has started' });
    await manager.shutdown();
  });

  it('a maintenance-boot child gets the own choice: the chosen entry, or the login-refused text', async () => {
    const manager = new BotManager();
    await manager.start();
    const before = webuiReportCount();
    mode(forks.children[0], { mode: 'login-refused', boot: true });
    expect(webuiReportCount()).toBeGreaterThan(before);
    expect(await settledOwnChoice()).toEqual({ entry: A });
    _resetWebuiChoice();
    fake.answers = [{ kind: 'refused', address: 'a.example:5432/bot', entry: A } as ProbeAnswer];
    const refused = await settledOwnChoice();
    expect(refused).toEqual({ refusal: "Every database in DATA_BACKEND_URL that answers refuses the bot's login (SQLSTATE 28000); the Bot Manager blocks the login during maintenance" });
    await manager.shutdown();
  });

  it('a stop that gives up on the child raises the count and clears the report', async () => {
    forks.holdExit = true;
    const manager = new BotManager();
    await manager.start();
    store(forks.children[0], { url: A });
    const before = webuiReportCount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stopping = manager.shutdown(true);
    await vi.advanceTimersByTimeAsync(6_000);
    await stopping;
    vi.useRealTimers();
    expect(webuiReportCount()).toBeGreaterThan(before);
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'choosing the main database' });
  });
});

describe('decision 17: chooseNow()', () => {
  it('starts its own pass and read while a background choice runs, and answers from them', async () => {
    let inFlight = 0;
    let overlapped = false;
    let ownReads = 0;
    let answers = [answered(A, 1, 'M')];
    _setWebuiChoiceDeps({
      entries: () => parseAddressList(`${A},${W}`),
      probe: async () => {
        const mine = answers;
        if (++inFlight > 1) overlapped = true;
        await new Promise(resolve => setTimeout(resolve, 100));
        inFlight--;
        return mine;
      },
      readNotice: async own => { if (own) ownReads++; await new Promise(resolve => setTimeout(resolve, 100)); return { kind: 'none' }; },
      markerStoreId: () => 'store-1',
      noticeCheckOff: () => false,
    });
    resolveWebuiDatabase();
    await new Promise(resolve => setTimeout(resolve, 20));
    answers = [answered(W, 1, 'M')];
    const started = Date.now();
    const { resolution } = await chooseNow();
    expect(Date.now() - started).toBeLessThan(400);
    expect(overlapped).toBe(true);
    expect(ownReads).toBe(1);
    expect(resolution).toEqual({ entry: W });
  });

  it('with a bot process reporting A, the resolution answers A and chooseNow still runs a pass and a read of its own', async () => {
    setWebuiDataStoreUrl({ url: A });
    expect(resolveWebuiDatabase()).toEqual({ entry: A });
    expect(fake.probes).toBe(0);
    const { resolution, countAtStart } = await chooseNow();
    expect(fake.probes).toBe(1);
    expect(fake.ownReads).toBe(1);
    expect(resolution).toEqual({ entry: A });
    expect(countAtStart).toBe(webuiReportCount());
  });

  it('answers the report count read when it started', async () => {
    fake.probeMs = 50;
    const pending = chooseNow();
    const at = webuiReportCount();
    setWebuiDataStoreUrl({ url: A });
    const { countAtStart } = await pending;
    expect(countAtStart).toBe(at);
    expect(webuiReportCount()).toBeGreaterThan(countAtStart);
  });

  it('its result becomes the last result of the own choice', async () => {
    await chooseNow();
    expect(resolveWebuiDatabase()).toEqual({ entry: A });
  });

  it('D6: a PUT-era own result for A is dropped at each change of case, so after the bot ends no read gets A', async () => {
    setWebuiDataStoreUrl({ url: A });
    await chooseNow();
    setWebuiDataStoreUrl({ url: W });
    fake.answers = [answered(W, 2, 'N')];
    fake.probeMs = 100;
    setWebuiDataStoreUrl(null);
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'choosing the main database' });
    expect(await settledOwnChoice()).toEqual({ entry: W });
    noteWebuiChild('started');
    noteWebuiChild('gone');
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'choosing the main database' });
  });

  it('noteWebuiChild started then gone moves the case and the count', () => {
    const c0 = webuiReportCount();
    noteWebuiChild('started');
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'the bot process is starting; try again once it has started' });
    noteWebuiChild('gone');
    expect(webuiReportCount()).toBe(c0 + 2);
  });
});

describe('G8: the pools and the holder check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb5-reader-'));
  const ca = path.join(dir, 'ca.crt');
  fs.writeFileSync(ca, 'CA-BYTES');
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const TLS = `postgresql://u:p@10.0.0.5:5432/bot?sslmode=verify-full&sslrootcert=${ca}`;

  it('(1) runHolderCheck while the resolution refuses answers failed with the reason, and switchOnNotHeld words it', async () => {
    const check = await runHolderCheck('123456789012345678');
    expect(check.kind).toBe('failed');
    expect((check as any).error.message).toBe('choosing the main database');
    const plan: Plan = { kind: 'local', op: 'write', deadline: performance.now() + 60_000 };
    await switchOnNotHeld(plan, '123456789012345678');
    expect(plan.reply.error).toBe("Can't get an answer from the database to find the machine that runs this server (choosing the main database); nothing was saved. Try again in a moment.");
  });

  it('(2) a choosing report refuses with its reason; a held report answers the entry with held', () => {
    setWebuiDataStoreUrl({ url: null, choosing: true, reason: 'R' });
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'R' });
    setWebuiDataStoreUrl({ url: A, held: true, reason: 'R' });
    expect(resolveWebuiDatabase()).toEqual({ entry: A, held: { reason: 'R' } });
  });

  it('(3) the request pool for a verify-full IP entry has ssl.host and no connectionString', () => {
    _pgRequestDbForTests(TLS);
    const config = pools.configs.at(-1);
    expect(config.connectionString).toBeUndefined();
    expect(config).toMatchObject({ host: '10.0.0.5', ssl: { host: '10.0.0.5', ca: 'CA-BYTES' }, application_name: 'smdb-webui-requests' });
  });

  it("the reader's pool is built through pgConfig and rebuilt when the entry changes", async () => {
    setWebuiDataStoreUrl({ url: TLS });
    const reader = new WebuiDataReader();
    await reader.listGuilds();
    expect(pools.configs).toHaveLength(1);
    expect(pools.configs[0].connectionString).toBeUndefined();
    expect(pools.configs[0]).toMatchObject({ host: '10.0.0.5', ssl: { host: '10.0.0.5' }, application_name: 'smdb-webui-reader' });
    setWebuiDataStoreUrl({ url: A });
    await reader.listGuilds();
    expect(pools.configs).toHaveLength(2);
    expect(pools.configs[1]).toMatchObject({ host: 'a.example', database: 'bot' });
    expect(pools.ended).toBe(1);
  });

  it('a refusal reaches the reader as data backend unreachable with the reason added', async () => {
    setWebuiDataStoreUrl({ url: null, choosing: true, reason: 'R' });
    await expect(new WebuiDataReader().listGuilds()).rejects.toThrow('data backend unreachable (R)');
  });
});

// NB5F F1-4: the marker as the real writer leaves it, then its path replaced by a directory (EISDIR).
function markerAsDirectory(): string {
  fs.rmSync(MARKER_FILE, { recursive: true, force: true });
  writeFileMarker({ live: 'postgres', storeId: 'store-1', flippedAt: 1 });
  expect(fs.readFileSync(MARKER_FILE, 'utf-8')).toContain('"storeId": "store-1"');
  fs.rmSync(MARKER_FILE);
  fs.mkdirSync(MARKER_FILE);
  let message = '';
  try { fs.readFileSync(MARKER_FILE, 'utf-8'); } catch (error) { message = (error as Error).message; }
  expect(message).toMatch(/^EISDIR/);
  return `${MARKER_FILE} cannot be read (${message})`;
}

describe("NB5F F1-4: the web UI's own choice reads this machine's marker strictly", () => {
  it("with the marker a directory, the own choice and chooseNow() make no choice and give the marker's why", async () => {
    _setWebuiChoiceDeps({
      entries: () => parseAddressList(`${A},${W}`),
      probe: async () => fake.answers,
      readNotice: async () => fake.notice,
      noticeCheckOff: () => false,
    });
    try {
      const why = markerAsDirectory();
      const refusal = { refusal: `${why}, so the bot can't confirm which store this machine records` };
      expect(await settledOwnChoice()).toEqual(refusal);
      expect((await chooseNow()).resolution).toEqual(refusal);
    } finally {
      fs.rmSync(MARKER_FILE, { recursive: true, force: true });
    }
  });
});
