import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 2, the fixer's regression tests: each case fails on the build the round reviewed.

const h = vi.hoisted(() => ({
  beforeCreate: null as null | (() => void),
  failCreate: null as string | null,
  failUnlink: null as string | null,
  failRead: null as string | null,
}));

vi.mock('fs', async orig => {
  const real = await orig<any>();
  const isLock = (file: unknown) => path.basename(String(file)) === '.writer.lock';
  const wrapped = {
    ...real,
    openSync: (file: any, flags: any, ...rest: any[]) => {
      if (isLock(file) && flags === 'wx') {
        if (h.failCreate) throw Object.assign(new Error(`${h.failCreate}: refused`), { code: h.failCreate });
        const hook = h.beforeCreate;
        h.beforeCreate = null;
        hook?.();
      }
      return real.openSync(file, flags, ...rest);
    },
    readFileSync: (file: any, ...rest: any[]) => {
      if (isLock(file) && h.failRead) throw Object.assign(new Error(`${h.failRead}: refused`), { code: h.failRead });
      return real.readFileSync(file, ...rest);
    },
    unlinkSync: (file: any) => {
      if (isLock(file) && h.failUnlink) throw Object.assign(new Error(`${h.failUnlink}: refused`), { code: h.failUnlink });
      return real.unlinkSync(file);
    },
  };
  return { ...wrapped, default: wrapped };
});

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import fs from 'fs';
import { BotManager, populateTakeCause, waitingReadText } from '../../src/webui/botManager';
import {
  checkWriterLock, configureWriterLock, releaseWriterLock, takeWriterLock, takeWriterLockForBoot, writerLockDepth, writerLockPath,
} from '../../src/bot/internalSetup/utils/writerLock';
import { ProcessLock } from '../../src/bot/internalSetup/utils/processLock';
import { sendHopReply } from '../../src/webui/routes/config';
import { webhookAnswer } from '../../src/webui/routes/hopFailure';
import { forks, forkStage } from '../helpers/forkMock';
import { setBackendKind } from '../helpers/backendKind';

const live = new Set<number>([process.pid, 4242]);
const sent: any[] = [];

function freshLock(role: 'webui' | 'bot' = 'webui'): void {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  configureWriterLock(role, { pid: () => process.pid, alive: p => live.has(p), startOf: p => `start-${p}`, now: () => Date.now() });
}

beforeEach(() => {
  h.beforeCreate = null;
  h.failCreate = h.failUnlink = h.failRead = null;
  sent.length = 0;
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forkStage.stages = ['shared', 'guild'];
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  freshLock();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  h.beforeCreate = null;
  h.failCreate = h.failUnlink = h.failRead = null;
  delete (process as any).send;
  setBackendKind(null);
  forkStage.stages = ['shared', 'guild'];
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
});

describe('the holder check when its re-create finds a new lock (RS-6)', () => {
  it('reads the new lock in the same check and stops writing when it names another process', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(takeWriterLock().kind).toBe('taken');
    fs.unlinkSync(writerLockPath());
    h.beforeCreate = () => fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 4242, start: 'start-4242', role: 'import', at: Date.now() }));
    const check = checkWriterLock();
    expect(check).toMatchObject({ kind: 'deposed', holder: { pid: 4242, role: 'import' } });
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(4242);
  });
});

describe('a release that cannot remove the lock (RS-7)', () => {
  it('ProcessLock.release answers the errno instead of hiding it', () => {
    const lock = new ProcessLock({
      lockPath: writerLockPath(), takeoverPath: `${writerLockPath()}.takeover`, unparsableStaleMs: 10_000, takeoverStaleMs: 5_000,
      seams: { pid: () => process.pid, alive: () => true, startOf: () => null, now: () => Date.now() },
    });
    expect(lock.tryTake().kind).toBe('taken');
    h.failUnlink = 'EIO';
    expect(lock.release()).toBe('EIO');
    h.failUnlink = null;
    expect(lock.release()).toBeNull();
  });

  it('logs the failure and removes the file on a later try', () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(takeWriterLock().kind).toBe('taken');
    h.failUnlink = 'EIO';
    releaseWriterLock();
    expect(writerLockDepth()).toBe(0);
    expect(fs.existsSync(writerLockPath())).toBe(true);
    expect(errors.mock.calls.some(c => String(c[0]).startsWith(`[Data] Could not remove ${writerLockPath()} (EIO)`))).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(fs.existsSync(writerLockPath())).toBe(true);
    h.failUnlink = null;
    vi.advanceTimersByTime(5_000);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('a later try leaves a lock another process wrote meanwhile', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    takeWriterLock();
    h.failUnlink = 'EIO';
    releaseWriterLock();
    h.failUnlink = null;
    const other = JSON.stringify({ pid: 4242, start: 'start-4242', role: 'bot', at: Date.now() });
    fs.writeFileSync(writerLockPath(), other);
    vi.advanceTimersByTime(5_000);
    expect(fs.readFileSync(writerLockPath(), 'utf8')).toBe(other);
  });
});

describe('a bot that cannot read the lock at its start (RS-8)', () => {
  it('reports a read cause, not a disk that takes no writes', async () => {
    freshLock('bot');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    (process as any).send = (message: unknown) => { sent.push(message); return true; };
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 4242, start: 'start-4242', role: 'webui', at: Date.now() }));
    h.failRead = 'EACCES';
    await takeWriterLockForBoot(async () => {
      h.failRead = null;
      fs.rmSync(writerLockPath(), { force: true });
    }, () => 0);
    expect(sent[0]).toEqual({ type: 'data:writer', data: { stage: 'waiting', readCause: 'EACCES' } });
    expect(writerLockDepth()).toBe(1);
  });

  it('the web UI words the read cause on its own, in the route and the status', async () => {
    forkStage.stages = [];
    forks.holdExit = true;
    const manager = new BotManager();
    await manager.start();
    const child = forks.children.at(-1);
    child.emit('message', { type: 'data:writer', data: { stage: 'waiting', readCause: 'EACCES' } });
    const route = manager.writerRoute('shared') as any;
    expect(route).toMatchObject({ code: 'held-elsewhere', error: waitingReadText('EACCES') });
    expect(route.error).not.toMatch(/take writes/);
    expect(manager.getStatus().dataFiles).toEqual({ cannotRead: 'EACCES' });
  });
});

describe('a previous child not seen to exit while the lock is free (RS-9)', () => {
  it('refuses without claiming that child holds the data files', async () => {
    forks.holdExit = true;
    const manager = new BotManager();
    await manager.start();
    (manager as any).botProcess = null;
    const route = manager.writerRoute('shared') as any;
    expect(route.code).toBe('held-elsewhere');
    expect(route.error).toContain('may still open the data files');
    expect(route.error).not.toContain('still holds');
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});

describe("a JSON bot's guild file delete with no bot (D7, RS-5)", () => {
  it('answers bot-down and takes no lock', async () => {
    setBackendKind('file');
    const manager = new BotManager();
    const reply = await manager.writeGuildData({ guildId: '1', module: 'm', filename: 'f.json', op: 'delete' });
    expect(reply).toMatchObject({ ok: false, code: 'bot-down' });
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});

describe('an op taken out of the chain at a fork (D9, RS-11)', () => {
  it('is routed again with its route wait', async () => {
    const manager = new BotManager();
    let release!: (answer: unknown) => void;
    const held = manager.runLocalOp('held', () => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 5));
    const args = { providerId: 'stripe' };
    const queued = manager.runSharedOp('payment.webhook', args, { routeWaitMs: 5000 });
    await new Promise(resolve => setTimeout(resolve, 5));
    const again = vi.spyOn(manager, 'runSharedOp').mockResolvedValue({ ok: false, code: 'starting' });
    forks.holdExit = true;
    await manager.start();
    expect(again).toHaveBeenCalledWith('payment.webhook', args, { routeWaitMs: 5000 });
    release({ ok: true });
    await held;
    await queued;
  });
});

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

describe("a pending answer after a Stop keeps BotManager's text (D8)", () => {
  it('BotManager marks the stop wording and sendHopReply answers it as not confirmed', () => {
    const manager = new BotManager();
    (manager as any).stopKind = 'stop';
    const worded = (manager as any).wordedByStop('global.write', { ok: false, code: 'unconfirmed', answer: 'pending', partial: false, error: 'x' });
    expect(worded.stopWorded).toBe(true);
    const res = fakeRes();
    sendHopReply(res, worded);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ success: false, error: worded.error });
    expect(worded.error).toContain('it may be lost');
    const plain = fakeRes();
    sendHopReply(plain, { ok: false, code: 'unconfirmed', answer: 'pending', error: 'x' });
    expect(plain.statusCode).toBe(202);
  });
});

describe('the webhook answers', () => {
  it('an unknown provider id stays 404; a handler error 400; a refusal 503', () => {
    expect(webhookAnswer({ ok: true })).toMatchObject({ status: 200, body: { received: true } });
    expect(webhookAnswer({ ok: false, code: 'invalid', error: 'Unknown provider or no webhook handler: nope' }).status).toBe(404);
    expect(webhookAnswer({ ok: false, code: 'invalid', error: 'bad signature' }).status).toBe(400);
    expect(webhookAnswer({ ok: false, code: 'failed', error: 'premium-tiers.json cannot be read (EIO)' }).status).toBe(503);
  });
});

describe("the populate's skip line names the take's cause", () => {
  it('a lock /data cannot create gives the sheet text', () => {
    h.failCreate = 'EROFS';
    const route = new BotManager().writerRoute('shared') as any;
    expect(route.code).toBe('disk');
    expect(route.lockTake).toEqual({ kind: 'unwritable', errno: 'EROFS' });
    expect(populateTakeCause(route.lockTake)).toBe(`/data does not take writes (${writerLockPath()}: EROFS)`);
    expect(populateTakeCause({ kind: 'unreadable', errno: 'EACCES' })).toBe(`can't tell which process holds the data files (${writerLockPath()}: EACCES)`);
    expect(populateTakeCause({ kind: 'contended' })).toBe('another process is taking over the data files at this moment');
  });
});

describe('session paths under a relative data root (RS-10)', () => {
  it('a session file passes the shared gate and every other file does not', async () => {
    vi.resetModules();
    vi.doMock('../../src/utils/dataRoot', async orig => ({ ...(await orig<any>()), DATA_ROOT: 'rel-data' }));
    try {
      const dm = await import('../../src/bot/internalSetup/utils/dataManager');
      expect(dm.isSharedPath(path.join('rel-data', '_sessions', 'x.json'))).toBe(false);
      expect(dm.isSharedPath(path.join('rel-data', 'global', 'a.json'))).toBe(true);
    } finally {
      vi.doUnmock('../../src/utils/dataRoot');
      vi.resetModules();
    }
  });
});
