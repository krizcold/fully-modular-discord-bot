import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 code review round 1, the operations side: NB3-RS-2, RS-3 (the CLI), RS-4, RS-6, RS-7 and WS-1.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const graveyard = vi.hoisted(() => ({ files: [] as any[], pg: [] as any[], pgReads: 0 }));
const writes = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({ ...(await orig<any>()), listGraveyardEntries: async () => graveyard.files }));
vi.mock('../../src/webui/utils/webuiDataReader', async orig => ({
  ...(await orig<any>()),
  getWebuiDataReader: () => ({ listGraveyard: async () => { graveyard.pgReads++; return graveyard.pg; } }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async orig => ({ ...(await orig<any>()), recognitionRefusal: () => null }));
vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    atomicWriteFileSync: (...args: Parameters<typeof real.atomicWriteFileSync>) => {
      writes.calls.push(args);
      return real.atomicWriteFileSync(...args);
    },
  };
});

import { BotManager } from '../../src/webui/botManager';
import { runMigrate } from '../../src/cli/commands';
import { Client } from '../../src/cli/client';
import { EXIT_OK, EXIT_TIMEOUT } from '../../src/cli/output';
import { writeEnvDataBackend } from '../../src/utils/envLoader';
import { atomicWriteFileSync } from '../../src/bot/internalSetup/utils/atomicWrite';
import { createGraveyardRoutes } from '../../src/webui/routes/graveyard';
import { forks, forkLogin } from '../helpers/forkMock';
import { setBackendKind } from '../helpers/backendKind';

const root = process.env.DATA_DIR as string;
const ENV = path.join(root, '.env');
const MARKER = path.join(root, '.backend.json');

const STILL_STARTING = "The bot process is still starting; can't confirm whether it boots in maintenance; try again once it has started";
const IN_FLIGHT = 'A start or restart of the bot is in progress; try again once it ends';
const STOPPED_NOT_STARTED = 'The bot was stopped, but a data migration started meanwhile; it is started again once the migration ends';

beforeEach(() => {
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forkLogin.on = true;
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  forkLogin.on = true;
});

async function startUnderFakeTimers(manager: BotManager): Promise<void> {
  const started = manager.start();
  await vi.advanceTimersByTimeAsync(6000);
  expect((await started).success).toBe(true);
}

describe('NB3-RS-2: a child that has not reported its mode', () => {
  it('refuses with "still starting" until its first data:store', async () => {
    vi.useFakeTimers();
    forkLogin.on = false;
    const manager = new BotManager();
    await startUnderFakeTimers(manager);
    expect(manager.migrationBotState()).toEqual({ ok: false, error: STILL_STARTING });
    forks.children[0].emit('message', { type: 'data:store', data: { url: null } });
    expect(manager.migrationBotState()).toEqual({ ok: false, error: 'Stop the bot first' });
  });

  it('a maintenance:mode message reports it: the boot flag passes, a serving mode refuses', async () => {
    vi.useFakeTimers();
    forkLogin.on = false;
    const booted = new BotManager();
    await startUnderFakeTimers(booted);
    forks.children[0].emit('message', { type: 'maintenance:mode', data: { mode: 'maintenance', boot: true } });
    expect(booted.migrationBotState()).toEqual({ ok: true });
    const serving = new BotManager();
    await startUnderFakeTimers(serving);
    forks.children[1].emit('message', { type: 'maintenance:mode', data: { mode: 'running' } });
    expect(serving.migrationBotState()).toEqual({ ok: false, error: 'Stop the bot first' });
  });

  it("the child's own login line reports it", async () => {
    vi.useFakeTimers();
    forkLogin.on = false;
    const manager = new BotManager();
    await startUnderFakeTimers(manager);
    expect(manager.migrationBotState()).toEqual({ ok: false, error: STILL_STARTING });
    forks.children[0].stdout.emit('data', Buffer.from('Logged in as test#0001!\n'));
    expect(manager.migrationBotState()).toEqual({ ok: false, error: 'Stop the bot first' });
  });

  it('a restarted child is not reported by the previous one, and waitForBotReady reads only its own login line', async () => {
    vi.useFakeTimers();
    const manager = new BotManager();
    const first = manager.start();
    await vi.advanceTimersByTimeAsync(600);
    expect((await first).success).toBe(true);
    const stop = manager.shutdown();
    await vi.advanceTimersByTimeAsync(100);
    await stop;
    forkLogin.on = false;
    let settled = false;
    const second = manager.start().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await second).success).toBe(true);
    expect(manager.migrationBotState()).toEqual({ ok: false, error: STILL_STARTING });
  });
});

describe('NB3-RS-4: a start or restart in flight', () => {
  it('a start in flight refuses', async () => {
    const manager = new BotManager();
    const started = manager.start();
    expect(manager.migrationBotState()).toEqual({ ok: false, error: IN_FLIGHT });
    expect((await started).success).toBe(true);
    expect(manager.migrationBotState()).toEqual({ ok: false, error: 'Stop the bot first' });
    await manager.shutdown();
  });

  it('a restart still stopping its child refuses', async () => {
    const manager = new BotManager();
    await manager.start();
    forks.holdExit = true;
    const restarted = manager.restart();
    const deadline = Date.now() + 5_000;
    while (forks.children[0].kill.mock.calls.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 2));
    expect(manager.migrationBotState()).toEqual({ ok: false, error: IN_FLIGHT });
    forks.holdExit = false;
    const child = forks.children[0];
    child.exitCode = 0;
    child.emit('exit', 0, null);
    expect((await restarted).success).toBe(true);
    expect(manager.migrationBotState()).toEqual({ ok: false, error: 'Stop the bot first' });
    await manager.shutdown();
  });

  it('a restart the bot process asked for, queued behind a start, refuses until it ran', async () => {
    const manager = new BotManager();
    const started = manager.start();
    const queued = manager.requestRestart();
    expect(manager.migrationBotState()).toEqual({ ok: false, error: IN_FLIGHT });
    await started;
    expect(manager.migrationBotState()).toEqual({ ok: false, error: IN_FLIGHT });
    expect((await queued).success).toBe(true);
    expect(manager.migrationBotState()).toEqual({ ok: false, error: 'Stop the bot first' });
    await manager.shutdown();
  });

  it('a restart whose start is refused after its stop says the bot was stopped', async () => {
    const manager = new BotManager();
    await manager.start();
    const restarted = manager.restart();
    expect(manager.takeMigrationLock({ jobId: 'job-rs4-00001', to: 'postgres' })).toBe(true);
    const result = await restarted;
    expect(result).toMatchObject({ success: false, reason: 'migration_running', error: STOPPED_NOT_STARTED });
    expect(manager.isRunning()).toBe(false);
    manager.releaseMigrationLock();
  });

  it('a restart refused before its stop keeps the child and says only that a migration runs', async () => {
    const manager = new BotManager();
    await manager.start();
    manager.takeMigrationLock({ jobId: 'job-rs4-00002', to: 'postgres' });
    const result = await manager.restart();
    expect(result).toMatchObject({ success: false, reason: 'migration_running', error: 'A data migration is running' });
    expect(manager.isRunning()).toBe(true);
    manager.releaseMigrationLock();
    await manager.shutdown();
  });
});

type Step = { status: number; body: unknown } | Error;

/** A panel stand-in for the CLI: a scripted POST answer, then GET answers in turn (the last repeats); an Error rejects. The bot status answers `bot`. */
function scripted(post: Step, gets: Step[], bot: Step = new Error('no bot status scripted')) {
  const sent: Array<{ method: string; path?: string; timeoutMs?: number }> = [];
  let i = 0;
  const answer = (step: Step) => {
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve({ status: step.status, ok: step.status >= 200 && step.status < 300, body: step.body });
  };
  return {
    sent,
    gets: () => sent.filter(s => s.method === 'GET' && s.path !== '/api/bot/status').length,
    client: {
      request: (method: string, p: string, opts: { timeoutMs?: number } = {}) => {
        sent.push({ method, path: p, timeoutMs: opts.timeoutMs });
        if (method === 'POST') return answer(post);
        if (p === '/api/bot/status') return answer(bot);
        return answer(gets[Math.min(i++, gets.length - 1)]);
      },
    } as any,
  };
}
const ok = (body: unknown): Step => ({ status: 200, body });
const started = ok({ success: true, jobId: 'job-cli-00001', to: 'postgres', state: 'started' });
const job = (state: string, extra: object = {}) => ok({ success: true, job: { jobId: 'job-cli-00001', to: 'postgres', stage: 'env', state, ...extra } });
const opts = { intervalMs: 1, timeoutMs: 5000 };

describe('NB3-RS-6: the CLI and request errors', () => {
  it('a POST that fails in transport says it cannot confirm the start and names the check', async () => {
    const p = scripted(new Error('socket hang up'), []);
    const result = await runMigrate(p.client, 'postgres', opts);
    expect(result.code).not.toBe(EXIT_OK);
    expect(result.message).toMatch(/^can't confirm whether the migration started; check with: smdb api GET \/api\/data\/migrate/);
    expect(result.message).toContain('socket hang up');
    expect(p.gets()).toBe(0);
  });

  it('a POST answered 502 without a refusal body says it cannot confirm the start', async () => {
    const p = scripted({ status: 502, body: 'Bad Gateway' }, []);
    const result = await runMigrate(p.client, 'postgres', opts);
    expect(result.code).not.toBe(EXIT_OK);
    expect(result.message).toMatch(/^can't confirm whether the migration started/);
  });

  it('a 500 that carries a refusal stays a refusal', async () => {
    const p = scripted({ status: 500, body: { success: false, error: 'The request could not be answered: x' } }, []);
    expect((await runMigrate(p.client, 'postgres', opts)).message).toBe('migration refused: The request could not be answered: x');
  });

  it('GET polls retry errors, 429 and 5xx, then follow the job to done', async () => {
    const p = scripted(started, [new Error('connect ECONNREFUSED'), { status: 429, body: {} }, { status: 503, body: 'down' }, job('running'), job('done')]);
    const result = await runMigrate(p.client, 'postgres', opts);
    expect(result.code).toBe(EXIT_OK);
    expect(p.gets()).toBe(5);
  });

  it('a deadline passed after errors says it cannot confirm the outcome', async () => {
    const p = scripted(started, [new Error('connect ECONNREFUSED')]);
    const result = await runMigrate(p.client, 'postgres', { intervalMs: 1, timeoutMs: 30 });
    expect(result.code).toBe(EXIT_TIMEOUT);
    expect(result.message).toMatch(/^can't confirm the outcome of migration job-cli-00001; the last status request failed \(connect ECONNREFUSED\)/);
    const q = scripted(started, [{ status: 429, body: {} }]);
    const second = await runMigrate(q.client, 'postgres', { intervalMs: 1, timeoutMs: 30 });
    expect(second.code).toBe(EXIT_TIMEOUT);
    expect(second.message).toContain("can't confirm the outcome of migration job-cli-00001");
  });

  it('a status answer with success false says it cannot confirm the outcome', async () => {
    const p = scripted(started, [ok({ success: false, error: "can't confirm which store holds the data: x" })]);
    const result = await runMigrate(p.client, 'postgres', opts);
    expect(result.code).not.toBe(EXIT_OK);
    expect(result.message).toMatch(/^can't confirm the outcome of migration job-cli-00001: /);
  });

  it('done says a stopped bot is to be started, from the POST and from a poll', async () => {
    const stopped = ok({ success: true, status: { running: false } });
    const fromPost = await runMigrate(scripted(ok({ success: true, jobId: 'job-cli-00001', to: 'postgres', state: 'done' }), [], stopped).client, 'postgres', opts);
    expect(fromPost.code).toBe(EXIT_OK);
    expect(fromPost.message).toMatch(/^migration job-cli-00001 is done; .*start it \(smdb start\)/);
    expect(fromPost.message).not.toContain('is not serving');
    const fromPoll = await runMigrate(scripted(started, [job('done')], stopped).client, 'postgres', opts);
    expect(fromPoll.message).toMatch(/start it \(smdb start\)/);
  });

  it('every request carries a timeout', async () => {
    const p = scripted(started, [job('done')]);
    await runMigrate(p.client, 'postgres', opts);
    expect(p.sent.every(s => typeof s.timeoutMs === 'number' && s.timeoutMs > 0)).toBe(true);
  });

  it('Client.request rejects a request that gets no answer within its timeout', async () => {
    const server = http.createServer(() => undefined);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const client = new Client({ host: '127.0.0.1', port: (server.address() as AddressInfo).port });
      await expect(client.request('GET', '/api/data/migrate', { timeoutMs: 100 })).rejects.toThrow(/no answer within/);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe('NB3-RS-3: the CLI and a status that names another job', () => {
  it('stops at once when no job runs and the status names another jobId', async () => {
    const p = scripted(started, [ok({ success: true, job: { jobId: 'job-earlier-01', to: 'postgres', stage: 'env', state: 'done' } }), job('done')]);
    const result = await runMigrate(p.client, 'postgres', opts);
    expect(result.code).not.toBe(EXIT_OK);
    expect(result.message).toMatch(/^can't confirm the outcome of migration job-cli-00001/);
    expect(p.gets()).toBe(1);
  });

  it('keeps following while another job runs', async () => {
    const p = scripted(started, [ok({ success: true, job: { jobId: 'job-other-0001', to: 'postgres', stage: 'copying', state: 'running' } }), job('done')]);
    expect((await runMigrate(p.client, 'postgres', opts)).code).toBe(EXIT_OK);
  });
});

describe('NB3-RS-7: the DATA_BACKEND writer keeps /data/.env mode and owner', () => {
  afterEach(() => {
    fs.rmSync(ENV, { force: true });
    writes.calls.length = 0;
  });

  it('hands the existing mode and owner to the atomic write', () => {
    fs.writeFileSync(ENV, 'DISCORD_TOKEN=x\nDATA_BACKEND=file\n');
    const st = fs.statSync(ENV);
    writeEnvDataBackend('postgres');
    expect(writes.calls.at(-1)?.[2]).toEqual({ mode: st.mode, uid: st.uid, gid: st.gid });
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DISCORD_TOKEN=x\nDATA_BACKEND=postgres\n');
  });

  it('a missing /data/.env is written with no kept mode', () => {
    writeEnvDataBackend('file');
    expect(writes.calls.at(-1)?.[2]).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('a 0600 /data/.env stays 0600', () => {
    fs.writeFileSync(ENV, 'DISCORD_TOKEN=x\n');
    fs.chmodSync(ENV, 0o600);
    writeEnvDataBackend('postgres');
    expect(fs.statSync(ENV).mode & 0o777).toBe(0o600);
  });

  it('atomicWriteFileSync gives the new file the kept mode', () => {
    const file = path.join(root, 'kept-mode.txt');
    const st = fs.statSync(root);
    atomicWriteFileSync(file, 'a', { mode: 0o100444, uid: st.uid, gid: st.gid });
    try {
      expect(fs.statSync(file).mode & 0o222).toBe(0);
    } finally {
      fs.chmodSync(file, 0o666);
      fs.rmSync(file, { force: true });
    }
  });
});

describe('NB3-WS-1: the graveyard lists only the live store', () => {
  const fileEntry = { guildId: '111', retiredAt: 2, reason: 'left' };
  const pgEntry = { guildId: '111', retiredAt: 2, reason: 'left', rows: 3 };

  async function list(): Promise<any[]> {
    const router: any = createGraveyardRoutes({} as any);
    const layer = router.stack.find((l: any) => l.route?.path === '/' && l.route.methods.get);
    const out = { status: 200, body: undefined as any };
    const res: any = {
      status(s: number) { out.status = s; return res; },
      json(b: any) { out.body = b; return res; },
    };
    await layer.route.stack[0].handle({}, res);
    expect(out.status).toBe(200);
    return out.body.entries;
  }

  beforeEach(() => {
    graveyard.files = [fileEntry];
    graveyard.pg = [pgEntry];
    graveyard.pgReads = 0;
    fs.rmSync(MARKER, { force: true });
  });
  afterEach(() => fs.rmSync(MARKER, { force: true }));

  it('after a move to Postgres the stale /data/_graveyard is not listed', async () => {
    fs.writeFileSync(MARKER, JSON.stringify({ live: 'postgres', storeId: 'store-1', flippedAt: 1, migration: 'job-ws1-00001' }));
    setBackendKind('postgres');
    expect(await list()).toEqual([{ ...pgEntry, backend: 'postgres' }]);
  });

  it('a file store lists the file graveyard and reads no database', async () => {
    fs.writeFileSync(MARKER, JSON.stringify({ live: 'file', storeId: null, flippedAt: 1, migration: 'job-ws1-00002' }));
    setBackendKind('file');
    expect(await list()).toEqual([{ ...fileEntry, backend: 'file' }]);
    expect(graveyard.pgReads).toBe(0);
  });

  it('with no marker DATA_BACKEND decides', async () => {
    setBackendKind('postgres');
    expect(await list()).toEqual([{ ...pgEntry, backend: 'postgres' }]);
    setBackendKind('file');
    expect(await list()).toEqual([{ ...fileEntry, backend: 'file' }]);
  });
});
