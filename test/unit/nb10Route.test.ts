import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 3: BotManager.writerRoute in each state, with the writer lock's facts injected.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, ROUTE_TEXT } from '../../src/webui/botManager';
import { configureWriterLock, releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks, forkStage } from '../helpers/forkMock';
import { setBackendKind } from '../helpers/backendKind';

const live = new Set<number>([process.pid]);
const report = (child: any, data: object) => child.emit('message', { type: 'data:writer', data });
const lockNaming = (holder: object) => fs.writeFileSync(writerLockPath(), JSON.stringify({ start: null, at: Date.now(), ...holder }));

beforeEach(() => {
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forkStage.stages = [];
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  configureWriterLock('webui', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  forkStage.stages = ['shared', 'guild'];
  vi.restoreAllMocks();
  while (writerLockDepth() > 0) releaseWriterLock();
});

async function started(): Promise<{ manager: BotManager; child: any }> {
  const manager = new BotManager();
  forks.holdExit = true;
  await manager.start();
  return { manager, child: forks.children.at(-1) };
}

describe('the writer route', () => {
  it('no child and a free lock: local, and the lock names the web UI', () => {
    const manager = new BotManager();
    expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8'))).toMatchObject({ pid: process.pid, role: 'webui' });
  });

  it('a lock naming a dead pid is taken over: local', () => {
    lockNaming({ pid: 999_991, role: 'bot' });
    expect(new BotManager().writerRoute('shared')).toEqual({ route: 'local' });
  });

  it('a contended take gives the taking-over text and names no pid', () => {
    lockNaming({ pid: 999_991, role: 'bot' });
    fs.writeFileSync(`${writerLockPath()}.takeover`, '');
    const route = new BotManager().writerRoute('shared');
    fs.rmSync(`${writerLockPath()}.takeover`, { force: true });
    expect(route).toMatchObject({ code: 'held-elsewhere', error: ROUTE_TEXT.contended });
    expect((route as any).error).not.toMatch(/pid/);
  });

  it('another live bot or an import holding the lock names it, with a next step', () => {
    live.add(5151);
    lockNaming({ pid: 5151, role: 'bot' });
    expect(new BotManager().writerRoute('shared')).toMatchObject({ code: 'held-elsewhere', error: expect.stringContaining('a bot process this web UI did not start, pid 5151') });
    lockNaming({ pid: 5151, role: 'import' });
    const route = new BotManager().writerRoute('shared') as any;
    expect(route.error).toContain('a data bundle import, pid 5151');
    expect(route.error).toContain('Stop that process or wait until it ends, then try again.');
  });

  it('an unreadable lock file gives the can\'t-confirm text with its next step', () => {
    fs.mkdirSync(writerLockPath());
    const route = new BotManager().writerRoute('shared') as any;
    fs.rmdirSync(writerLockPath());
    expect(route.error).toMatch(/^Can't confirm which process holds the data files \(.*\); nothing was saved\. Check that the web UI can read that file\.$/);
  });

  it('a child with no report is starting; a waiting child names the holder; stages route shared and guild', async () => {
    const { manager, child } = await started();
    expect(manager.writerRoute('shared')).toMatchObject({ code: 'starting', error: ROUTE_TEXT.starting });
    report(child, { stage: 'waiting', holder: { role: 'webui', pid: 77 } });
    expect(manager.writerRoute('shared')).toMatchObject({ code: 'starting', error: 'The bot is waiting for the web UI (pid 77) to release the data files; nothing was saved. Try again once it has.' });
    report(child, { stage: 'waiting', cause: 'EROFS' });
    expect(manager.writerRoute('guild')).toMatchObject({ code: 'disk', error: expect.stringContaining('waiting for the data disk to take writes') });
    report(child, { stage: 'shared' });
    expect(manager.writerRoute('shared')).toEqual({ route: 'child' });
    expect(manager.writerRoute('guild')).toMatchObject({ code: 'starting' });
    report(child, { stage: 'guild' });
    expect(manager.writerRoute('guild')).toEqual({ route: 'child' });
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('a stop sent gives the stopping text, the stop of a restart the restarting text', async () => {
    const { manager, child } = await started();
    report(child, { stage: 'guild' });
    void manager.shutdown(false);
    expect(manager.writerRoute('shared')).toMatchObject({ code: 'stopping', error: ROUTE_TEXT.stopping });
    child.exitCode = 0;
    child.emit('exit', 0, null);
    const again = await started();
    report(again.child, { stage: 'guild' });
    void again.manager.restart();
    expect(again.manager.writerRoute('shared')).toMatchObject({ code: 'stopping', error: ROUTE_TEXT.restarting });
    again.child.exitCode = 0;
    again.child.emit('exit', 0, null);
  });

  it('a previous child whose exit was not seen holds the lock: its pid is named', async () => {
    const { manager, child } = await started();
    live.add(child.pid);
    lockNaming({ pid: child.pid, role: 'bot' });
    forks.holdExit = true;
    const stopping = manager.shutdown(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    (manager as any).botProcess = null;
    const route = manager.writerRoute('shared') as any;
    expect(route.code).toBe('held-elsewhere');
    expect(route.error.startsWith(`A previous bot process this web UI started (pid ${child.pid}) has not exited yet`)).toBe(true);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await stopping;
  });

  it('two forks: the first child, not lastChild, whose exit was not seen holds the lock and is named', async () => {
    const manager = new BotManager();
    forks.holdExit = true;
    await manager.start();
    const first = forks.children.at(-1);
    // The first child is left behind without its exit (a stop whose child outlived the wait), and a second one starts.
    (manager as any).botProcess = null;
    await manager.start();
    const second = forks.children.at(-1);
    expect(second).not.toBe(first);
    (manager as any).botProcess = null;
    second.exitCode = 0;
    second.emit('exit', 0, null);
    live.add(first.pid);
    lockNaming({ pid: first.pid, role: 'bot' });
    const route = manager.writerRoute('shared') as any;
    expect(route).toMatchObject({ code: 'held-elsewhere' });
    expect(route.error.startsWith(`A previous bot process this web UI started (pid ${first.pid}) has not exited yet`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(first.pid);
    first.exitCode = 0;
    first.emit('exit', 0, null);
  });

  it('a Postgres guild write with no child answers bot-down and takes nothing', () => {
    setBackendKind('postgres');
    expect(new BotManager().writerRoute('guild', { postgresGuild: true })).toMatchObject({ code: 'bot-down' });
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('after beginExit every write is refused with the shutting-down text', () => {
    const manager = new BotManager();
    manager.beginExit();
    expect(manager.writerRoute('shared')).toMatchObject({ code: 'stopping', error: ROUTE_TEXT.exiting });
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});

describe('a deposed bot exit (NB10 test 38)', () => {
  it('exit code 75 is no crash: the holder is logged, no recordCrash, and a new child is forked after the delay', async () => {
    const { manager, child } = await started();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      safety.recordCrash.mockClear();
      const warns = vi.mocked(console.warn);
      report(child, { stage: 'deposed', holder: { role: 'import', pid: 31 } });
      child.exitCode = 75;
      child.emit('exit', 75, null);
      expect(safety.recordCrash).not.toHaveBeenCalled();
      expect(warns.mock.calls.some(c => String(c[0]).includes("a data bundle import (pid 31) took the data files' lock"))).toBe(true);
      expect(manager.getStatus().crashed).toBe(false);
      const before = forks.children.length;
      await vi.advanceTimersByTimeAsync(5_100);
      expect(forks.children.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exit code 75 with no message: the holder is read from the lock file, and nothing counts as a crash', async () => {
    const { manager, child } = await started();
    const broadcast = vi.fn();
    manager.setWebSocketManager({ broadcast } as any);
    (manager as any).crashLogs = ['an earlier crash'];
    (manager as any).crashRestarts = 2;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      safety.recordCrash.mockClear();
      lockNaming({ pid: 31, role: 'import' });
      child.exitCode = 75;
      child.emit('exit', 75, null);
      expect(vi.mocked(console.warn).mock.calls.some(c => String(c[0]) === "[BotManager] The bot process stopped: a data bundle import (pid 31) took the data files' lock")).toBe(true);
      expect(safety.recordCrash).not.toHaveBeenCalled();
      expect(broadcast.mock.calls.some(c => c[0] === 'bot:crash')).toBe(false);
      expect((manager as any).crashLogs).toEqual(['an earlier crash']);
      expect((manager as any).crashRestarts).toBe(2);
      expect(manager.getStatus().crashed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a deposed exit after a requested stop forks no new child', async () => {
    const { manager, child } = await started();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const stopping = manager.shutdown(false);
      report(child, { stage: 'deposed', holder: { role: 'webui', pid: 31 } });
      child.exitCode = 75;
      child.emit('exit', 75, null);
      await vi.advanceTimersByTimeAsync(6_000);
      await stopping;
      const before = forks.children.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(forks.children.length).toBe(before);
      expect(manager.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a child that reports deposed and exits 1 is a crash', async () => {
    const { child } = await started();
    safety.recordCrash.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    report(child, { stage: 'deposed', holder: { role: 'bot', pid: 31 } });
    child.exitCode = 1;
    child.emit('exit', 1, null);
    expect(safety.recordCrash).toHaveBeenCalled();
  });
});
