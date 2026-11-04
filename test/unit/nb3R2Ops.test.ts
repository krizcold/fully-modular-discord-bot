import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 code review round 2, the operations side: NB3-R2-5, NB3-R2-OPS-1 (the CLI), OPS-2 and OPS-5.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const chown = vi.hoisted(() => ({ fail: [] as Array<(uid: number) => boolean>, calls: [] as Array<[number, number]> }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('fs', async orig => {
  const actual = await orig<typeof import('fs')>();
  const fchownSync = (_fd: number, uid: number, gid: number) => {
    chown.calls.push([uid, gid]);
    if (chown.fail.some(f => f(uid))) throw Object.assign(new Error('EPERM: operation not permitted, fchown'), { code: 'EPERM' });
  };
  return { ...actual, fchownSync, default: { ...actual, fchownSync } };
});

import { BotManager } from '../../src/webui/botManager';
import { dispatch, runMigrate } from '../../src/cli/commands';
import { Client } from '../../src/cli/client';
import { EXIT_ERR, EXIT_OK } from '../../src/cli/output';
import { atomicWriteFileSync } from '../../src/bot/internalSetup/utils/atomicWrite';
import { forks, forkLogin } from '../helpers/forkMock';

const root = process.env.DATA_DIR as string;
const STOPPED_STARTED_LATER = 'The bot was stopped, but a data migration started meanwhile; it is started again once the migration ends';

beforeEach(() => {
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forkLogin.on = true;
  chown.fail = [];
  chown.calls = [];
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

describe('NB3-R2-5: a failed owner change keeps the group where it may', () => {
  const file = path.join(root, 'kept-group.txt');
  afterEach(() => fs.rmSync(file, { force: true }));

  it('a refused fchown(uid, gid) is followed by fchown(-1, gid)', () => {
    chown.fail = [uid => uid !== -1];
    atomicWriteFileSync(file, 'a', { mode: 0o100640, uid: 0, gid: 4242 });
    expect(chown.calls).toEqual([[0, 4242], [-1, 4242]]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('a');
  });

  it('a refused group change too still writes the file', () => {
    chown.fail = [() => true];
    atomicWriteFileSync(file, 'b', { mode: 0o100640, uid: 0, gid: 4242 });
    expect(chown.calls).toEqual([[0, 4242], [-1, 4242]]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('b');
  });

  it('a granted fchown(uid, gid) is not followed by a second one', () => {
    atomicWriteFileSync(file, 'c', { mode: 0o100640, uid: 0, gid: 4242 });
    expect(chown.calls).toEqual([[0, 4242]]);
  });
});

type Step = { status: number; body: unknown } | Error;

function panel(post: Step, gets: Step[], bot: Step) {
  let i = 0;
  const answer = (step: Step) => {
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve({ status: step.status, ok: step.status >= 200 && step.status < 300, body: step.body });
  };
  return {
    request: (method: string, p: string) => {
      if (method === 'POST') return answer(post);
      if (p === '/api/bot/status') return answer(bot);
      return answer(gets[Math.min(i++, gets.length - 1)]);
    },
  } as any;
}
const ok = (body: unknown): Step => ({ status: 200, body });
const doneFromPost = ok({ success: true, jobId: 'job-r2-000001', to: 'postgres', state: 'done' });
const started = ok({ success: true, jobId: 'job-r2-000001', to: 'postgres', state: 'started' });
const doneJob = ok({ success: true, job: { jobId: 'job-r2-000001', to: 'postgres', stage: 'env', state: 'done' } });
const bot = (running: unknown) => ok({ success: true, status: { running } });
const opts = { intervalMs: 1, timeoutMs: 5000 };

describe('NB3-R2-OPS-1: the next step after done follows the bot status', () => {
  it('a stopped bot is told to start (smdb start)', async () => {
    const result = await runMigrate(panel(doneFromPost, [], bot(false)), 'postgres', opts);
    expect(result).toMatchObject({ code: EXIT_OK, message: 'migration job-r2-000001 is done; the bot is stopped: start it (smdb start)' });
  });

  it('a running bot (a case 1 answer to a bot that serves) is not told it is stopped', async () => {
    const result = await runMigrate(panel(doneFromPost, [], bot(true)), 'postgres', opts);
    expect(result.code).toBe(EXIT_OK);
    expect(result.message).toBe('migration job-r2-000001 is done; the bot runs; restart it if it runs in maintenance');
    expect(result.message).not.toContain('smdb start');
  });

  it('an unreadable status says it cannot confirm and starts the bot only if it is stopped', async () => {
    const unknown = "migration job-r2-000001 is done; can't confirm whether the bot runs: start the bot if it is stopped (smdb start)";
    for (const status of [new Error('socket hang up'), { status: 500, body: 'down' }, bot('yes'), ok('not json')] as Step[]) {
      const result = await runMigrate(panel(doneFromPost, [], status), 'postgres', opts);
      expect(result).toMatchObject({ code: EXIT_OK, message: unknown });
    }
  });

  it('a done seen by a poll reads the status too', async () => {
    const result = await runMigrate(panel(started, [doneJob], bot(true)), 'postgres', opts);
    expect(result.message).toBe('migration job-r2-000001 is done; the bot runs; restart it if it runs in maintenance');
  });
});

describe('NB3-R2-OPS-2: a cut answer rejects the request', () => {
  async function serve(handler: http.RequestListener): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    return {
      client: new Client({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }),
      close: async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      },
    };
  }

  it('a socket closed after the headers and part of the body rejects', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{"success":');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    try {
      await expect(s.client.request('GET', '/api/data/migrate', { timeoutMs: 5000 })).rejects.toThrow('the answer was cut off');
    } finally {
      await s.close();
    }
  });

  it('a socket the server ends cleanly after the headers and part of the body rejects as cut off, before the timeout', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{"success":');
      setTimeout(() => res.socket?.end(), 20);
    });
    try {
      await expect(s.client.request('GET', '/api/data/migrate', { timeoutMs: 5000 })).rejects.toThrow('the answer was cut off');
    } finally {
      await s.close();
    }
  });

  it('a timeout that fires after the headers rejects (through the request error, which held before OPS-2)', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{"success":');
    });
    try {
      await expect(s.client.request('GET', '/api/data/migrate', { timeoutMs: 100 })).rejects.toThrow();
    } finally {
      await s.close();
    }
  });

  it('a whole answer still resolves', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"success":true}');
    });
    try {
      await expect(s.client.request('GET', '/api/data/migrate', { timeoutMs: 5000 })).resolves.toMatchObject({ status: 200, body: { success: true } });
    } finally {
      await s.close();
    }
  });

  it('the migrate verb sets the error exit code before it awaits the panel', async () => {
    const before = process.exitCode;
    try {
      const pending = { request: () => new Promise(() => undefined) } as any;
      void dispatch(pending, ['data', 'migrate'], { to: 'postgres' });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(process.exitCode).toBe(EXIT_ERR);
    } finally {
      process.exitCode = before;
    }
  });
});

describe('NB3-R2-OPS-5: a restart refused by the migration lock starts the bot at the release', () => {
  it('the answer says the bot starts again, and the release starts it once', async () => {
    const manager = new BotManager();
    await manager.start();
    const restarted = manager.restart();
    expect(manager.takeMigrationLock({ jobId: 'job-r2-ops5-01', to: 'file' })).toBe(true);
    expect(await restarted).toMatchObject({ success: false, reason: 'migration_running', error: STOPPED_STARTED_LATER });
    expect(manager.isRunning()).toBe(false);
    const forked = forks.children.length;
    manager.releaseMigrationLock();
    await vi.waitFor(() => expect(manager.isRunning()).toBe(true));
    expect(forks.children.length).toBe(forked + 1);
    manager.releaseMigrationLock();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(forks.children.length).toBe(forked + 1);
    await manager.shutdown();
  });

  it('a stop requested before the release calls the start off', async () => {
    const manager = new BotManager();
    await manager.start();
    const restarted = manager.restart();
    manager.takeMigrationLock({ jobId: 'job-r2-ops5-02', to: 'file' });
    await restarted;
    await manager.shutdown();
    const forked = forks.children.length;
    manager.releaseMigrationLock();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(manager.isRunning()).toBe(false);
    expect(forks.children.length).toBe(forked);
  });

  it('a bot started meanwhile (a maintenance boot) is not started twice', async () => {
    const manager = new BotManager();
    await manager.start();
    const restarted = manager.restart();
    manager.takeMigrationLock({ jobId: 'job-r2-ops5-03', to: 'file' });
    await restarted;
    (manager as any).migrationLock = null;
    expect((await manager.start()).success).toBe(true);
    (manager as any).migrationLock = { jobId: 'job-r2-ops5-03', to: 'file' };
    const forked = forks.children.length;
    manager.releaseMigrationLock();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(forks.children.length).toBe(forked);
    await manager.shutdown();
  });
});
