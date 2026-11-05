import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation survivors (chunk 8, botManager.ts): the texts an operator sees when a write is refused, the bot
// process's exits, the maintenance hook's notes, the status's data-files field and the start's log line.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, populateTakeCause, deposedRouteText } from '../../src/webui/botManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks, forkLogin } from '../helpers/forkMock';
import { answering, exitChild, freshWriterLock, report, resetForks, sentTo, tick } from '../helpers/nb10Rig';

const managers: BotManager[] = [];
let logs: string[];
let warns: string[];
let errors: string[];

/** A BotManager whose polls wait at most cap ms, so a start returns within a few ms. */
function manager(cap = 10): BotManager {
  const m = new BotManager();
  (m as any).sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, cap)));
  managers.push(m);
  return m;
}

/** Starts a child that reports these data:writer messages first. */
async function startWith(stages: object[], m = manager()): Promise<{ m: BotManager; child: any; result: any }> {
  forks.onFork = child => { setTimeout(() => { for (const data of stages) report(child, data); }, 1); };
  const result = await m.start();
  forks.onFork = null;
  const child = forks.children.at(-1);
  await tick();
  return { m, child, result };
}

beforeEach(() => {
  resetForks();
  forks.holdExit = true;
  freshWriterLock('webui', new Set([process.pid, 5151]));
  logs = [];
  warns = [];
  errors = [];
  safety.recordCrash.mockClear();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
});

afterEach(() => {
  for (const m of managers.splice(0)) m.cancelCrashRestart();
  forks.onFork = null;
  forkLogin.on = true;
  vi.restoreAllMocks();
  fs.rmSync(writerLockPath(), { force: true });
  fs.rmSync(`${writerLockPath()}.takeover`, { force: true });
});

describe('the texts a refused write answers', () => {
  it('the populate skip line names an unparsable lock as a take in progress', () => {
    expect(populateTakeCause({ kind: 'unparsable' })).toBe('another process is taking the data files at this moment');
  });

  it('a write during a stop and during a restart says nothing was saved and when to save again', async () => {
    const a = await startWith([{ stage: 'guild' }]);
    void a.m.shutdown(false, 'stop');
    expect(a.m.writerRoute('shared')).toMatchObject({ code: 'stopping', error: 'The bot is stopping; nothing was saved. Save again once it has stopped.' });
    exitChild(a.child, 0);
    const b = await startWith([{ stage: 'guild' }]);
    void b.m.shutdown(false, 'restart');
    expect(b.m.writerRoute('shared')).toMatchObject({ code: 'stopping', error: 'The bot is restarting; nothing was saved. Save again once it is back.' });
    exitChild(b.child, 0);
  });

  it('a take in progress and an unparsable lock each answer their own text', () => {
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 999_991, role: 'bot', start: null, at: Date.now() }));
    fs.writeFileSync(`${writerLockPath()}.takeover`, '');
    expect(manager().writerRoute('shared')).toMatchObject({ code: 'held-elsewhere', error: 'Another process is taking over the data files at this moment; nothing was saved. Try again in a moment.' });
    fs.rmSync(`${writerLockPath()}.takeover`, { force: true });
    fs.writeFileSync(writerLockPath(), 'not a lock');
    expect(manager().writerRoute('shared')).toMatchObject({ code: 'held-elsewhere', error: 'Another process is taking the data files at this moment; nothing was saved. Try again in a moment.' });
  });

  it('a deposed child names the process that took the files, by its role', async () => {
    expect(deposedRouteText({ role: 'bot', pid: 31 })).toBe('Another process took the data files (a bot process this web UI did not start, pid 31); nothing was saved. Stop that process or wait until it ends, then try again.');
    const web = await startWith([{ stage: 'guild' }, { stage: 'deposed', holder: { role: 'webui', pid: 32 } }]);
    expect((web.m.writerRoute('shared') as any).error).toBe('Another process took the data files (the web UI, pid 32); nothing was saved. Stop that process or wait until it ends, then try again.');
    const blank = await startWith([{ stage: 'guild' }, { stage: 'deposed', holder: { role: '', pid: 33 } }]);
    expect((blank.m.writerRoute('shared') as any).error).toBe('Another process took the data files (another process, pid 33); nothing was saved. Stop that process or wait until it ends, then try again.');
  });

  it('a child waiting for a holder it cannot name says so', async () => {
    const { m } = await startWith([{ stage: 'waiting' }]);
    expect(m.writerRoute('shared')).toMatchObject({ code: 'starting', error: 'The bot is waiting for another process to release the data files; nothing was saved. Try again once it has.' });
  });

  it('a child that outlived its exit report still blocks a local take under a reused pid', async () => {
    const m = manager();
    forks.onFork = child => { child.pid = 7777; };
    await m.start();
    const first = forks.children.at(-1);
    first.exitCode = 0;
    forks.onFork = child => { child.pid = 7777; };
    await m.start();
    forks.onFork = null;
    const second = forks.children.at(-1);
    expect(second).not.toBe(first);
    first.emit('exit', 0, null);
    second.exitCode = 0;
    expect(m.writerRoute('shared')).toMatchObject({ code: 'held-elsewhere', error: expect.stringContaining('(pid 7777) has not exited yet') });
  });
});

describe('the exits of the bot process', () => {
  it('a deposed exit with no holder known says another process took the lock', async () => {
    const { child } = await startWith([{ stage: 'guild' }]);
    exitChild(child, 75);
    expect(warns).toContain("[BotManager] The bot process stopped: another process took the data files' lock");
  });

  it('a deposed exit after a requested stop says the bot is not started again', async () => {
    const { m, child } = await startWith([{ stage: 'guild' }]);
    m.cancelCrashRestart();
    exitChild(child, 75);
    expect(logs).toContain('[BotManager] The exit followed a requested stop; not starting the bot again');
    expect((m as any).crashRestartTimer).toBeNull();
  });

  it('an exit by signal with no code is no crash', async () => {
    const { m, child } = await startWith([{ stage: 'guild' }]);
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    expect(m.getStatus().crashed).toBe(false);
    expect(m.getLogs(true).crashed).toBe(false);
    expect(safety.recordCrash).not.toHaveBeenCalled();
  });

  it('a stop with no arguments sends SIGTERM, not SIGKILL', async () => {
    const { m, child } = await startWith([{ stage: 'guild' }]);
    const done = m.shutdown();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(logs).toContain('[BotManager] Shutting down bot with SIGTERM...');
    exitChild(child, 0);
    await done;
  });

  it('a panel update from the child reaches the web clients', async () => {
    const { m, child } = await startWith([{ stage: 'guild' }]);
    const broadcast = vi.fn();
    m.setWebSocketManager({ broadcast } as any);
    child.emit('message', { type: 'panel:live_update', data: { panelId: 'p1', guildId: 'g1', sessionId: null, response: { text: 'hi' } } });
    expect(broadcast).toHaveBeenCalledWith('panel:updated', expect.objectContaining({ panelId: 'p1', guildId: 'g1', panel: { text: 'hi' } }));
  });
});

describe('the start log of a child that waits', () => {
  it('names a lock it cannot read', async () => {
    const { result } = await startWith([{ stage: 'waiting', readCause: 'EACCES' }]);
    expect(result).toMatchObject({ success: true, waiting: true, cannotRead: 'EACCES' });
    expect(logs).toContain('[BotManager] The bot process started and cannot tell which process holds the data files (EACCES)');
  });

  it('names a holder it cannot name as another process', async () => {
    await startWith([{ stage: 'waiting' }]);
    expect(logs).toContain('[BotManager] The bot process started and waits for another process to release the data files');
  });

  it('a start whose child was replaced meanwhile reports the new child as no wait of its own', async () => {
    forks.holdExit = false;
    const m = manager(150);
    const first = m.start();
    await tick(10);
    await m.shutdown(true);
    forks.onFork = child => { setTimeout(() => report(child, { stage: 'waiting' }), 1); };
    const second = m.start();
    forks.onFork = null;
    const [a, b] = await Promise.all([first, second]);
    expect(b).toMatchObject({ success: true, waiting: true });
    expect(a).toEqual({ success: true });
  });
});

describe('the maintenance hook notes', () => {
  it('a deposed child with no holder known: enter and leave log the note they answer', async () => {
    const { m } = await startWith([{ stage: 'guild' }, { stage: 'deposed' }]);
    const enter = await m.enterMaintenance('m');
    expect(enter).toEqual({ saved: null, note: "The bot process is stopping: another process (a process this web UI cannot name) took the data files; can't confirm whether it holds unsaved changes" });
    expect(logs).toContain(`[BotManager] ${enter.note}`);
    const leave = await m.leaveMaintenance();
    expect(leave.restarting).toBeNull();
    expect(logs).toContain(`[BotManager] ${leave.note}`);
  });

  it('a child that exits before it opens the files: the note is logged', async () => {
    const { m, child } = await startWith([]);
    const entering = m.enterMaintenance('m');
    await tick();
    exitChild(child, 0);
    const answer = await entering;
    expect(answer).toEqual({ saved: true, note: 'The bot process exited before it opened the data files, so it holds no changes.' });
    expect(logs).toContain('[BotManager] The bot process exited before it opened the data files, so it holds no changes.');
  });

  it('a leave while the child is still starting logs its note', async () => {
    const { m } = await startWith([]);
    expect(await m.leaveMaintenance()).toEqual({ restarting: false, note: 'The bot process is still starting; it reads maintenance.json as it opens the data files and runs normally.' });
    expect(logs).toContain('[BotManager] The bot process is still starting; it reads maintenance.json as it opens the data files and runs normally.');
  });

  it('an enter that waited for the files leaves no 20 s timer behind', async () => {
    const { m, child } = await startWith([]);
    answering(child, message => (message.type === 'maintenance:enter' ? { saved: true } : undefined));
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const entering = m.enterMaintenance('m');
    await tick();
    report(child, { stage: 'shared' });
    expect(await entering).toEqual({ saved: true });
    expect(sentTo(child, 'maintenance:enter')).toHaveLength(1);
    const long = set.mock.calls.flatMap((call, i) => (call[1] === 20_000 ? [set.mock.results[i].value] : []));
    expect(long.length).toBeGreaterThan(0);
    const cleared = new Set(clear.mock.calls.map(c => c[0]));
    for (const timer of long) expect(cleared.has(timer)).toBe(true);
  });
});

describe('the status of the data files', () => {
  it('a child that waited and exited reports nothing to wait for', async () => {
    const { m, child } = await startWith([{ stage: 'waiting', cause: 'EROFS' }]);
    expect(m.getStatus().dataFiles).toEqual({ cannotLock: 'EROFS' });
    exitChild(child, 0);
    expect(m.getStatus().dataFiles).toBeNull();
  });

  it('a child that waited and was then deposed reports nothing to wait for', async () => {
    const { m } = await startWith([{ stage: 'waiting', cause: 'EROFS' }, { stage: 'deposed', holder: { role: 'bot', pid: 9 } }]);
    expect(m.getStatus().running).toBe(true);
    expect(m.getStatus().dataFiles).toBeNull();
  });
});
