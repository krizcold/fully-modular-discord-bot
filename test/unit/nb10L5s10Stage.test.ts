import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10, the child's data:writer reports as BotManager reads them: what the status shows, which stage waits resolve, the
// texts a request gets while the child has not opened its data files, and the web UI's own op while a child serves.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, ROUTE_TEXT } from '../../src/webui/botManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, quiet, report, resetForks, startedWith, tick } from '../helpers/nb10Rig';

const EXITED_TEXT = 'The bot process exited before it opened the data files';

/** How a promise stands after ms: resolved, rejected with its message, or still pending. */
function outcome(p: Promise<unknown>): { read: (ms?: number) => Promise<string> } {
  let state = 'pending';
  p.then(() => { state = 'resolved'; }, (e: unknown) => { state = `rejected: ${e instanceof Error ? e.message : String(e)}`; });
  return { read: async (ms = 20) => { await tick(ms); return state; } };
}

beforeEach(() => {
  quiet();
  resetForks();
  freshWriterLock('webui');
});

afterEach(() => {
  vi.useRealTimers();
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

describe('the reports a child sends', () => {
  it('a report with no data is ignored and does not throw out of the message handler', async () => {
    const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    expect(() => child.emit('message', { type: 'data:writer' })).not.toThrow();
    expect(() => child.emit('message', { type: 'data:writer', data: null })).not.toThrow();
    expect(manager.getStatus().dataFiles).toEqual({ waitingFor: { role: 'webui', pid: 77 } });
  });

  it('a report of an unknown stage leaves the waiting status as it was', async () => {
    const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    report(child, { stage: 'ready' });
    const status = manager.getStatus();
    expect(status.mode).toBe('waiting-for-data-files');
    expect(status.dataFiles).toEqual({ waitingFor: { role: 'webui', pid: 77 } });
  });

  it('a holder without a numeric pid is not shown, and the route names no process', async () => {
    const { manager } = await startedWith([{ stage: 'waiting', holder: { role: 'webui' } }]);
    expect(manager.getStatus().dataFiles).toBe(null);
    expect(manager.writerRoute('shared')).toMatchObject({ ok: false, code: 'starting', error: 'The bot is waiting for another process to release the data files; nothing was saved. Try again once it has.' });
  });

  it('a holder role that is not a string is shown as no role', async () => {
    const { manager } = await startedWith([{ stage: 'waiting', holder: { role: 7, pid: 77 } }]);
    expect(manager.getStatus().dataFiles).toEqual({ waitingFor: { role: null, pid: 77 } });
  });

  it('a cause that is not a string is not shown as a disk that refuses the lock', async () => {
    const { manager } = await startedWith([{ stage: 'waiting', cause: 5, holder: { role: 'webui', pid: 77 } }]);
    expect(manager.getStatus().dataFiles).toEqual({ waitingFor: { role: 'webui', pid: 77 } });
  });

  it('a read cause that is not a string is not shown as an unreadable lock', async () => {
    const { manager } = await startedWith([{ stage: 'waiting', readCause: 5, holder: { role: 'webui', pid: 77 } }]);
    expect(manager.getStatus().dataFiles).toEqual({ waitingFor: { role: 'webui', pid: 77 } });
  });

  it('a holder sent with the shared report does not name the process that later deposed the child', async () => {
    const warn = vi.mocked(console.warn);
    const { manager, child } = await startedWith([{ stage: 'shared', holder: { role: 'import', pid: 4242 } }]);
    expect(fs.existsSync(writerLockPath())).toBe(false);
    exitChild(child, 75);
    manager.cancelCrashRestart();
    const lines = logged(warn).filter(l => l.startsWith('[BotManager] The bot process stopped'));
    expect(lines).toEqual(["[BotManager] The bot process stopped: another process took the data files' lock"]);
  });
});

describe('whenStage', () => {
  it('with no child it rejects naming the process as not running', async () => {
    await expect(new BotManager().whenStage('shared')).rejects.toThrow(/^The bot process is not running$/);
  });

  it('a stage the child already reported resolves at once', async () => {
    const { manager } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    expect(await outcome(manager.whenStage('guild')).read()).toBe('resolved');
    expect(await outcome(manager.whenStage('shared')).read()).toBe('resolved');
  });

  it('another waiting report does not resolve a wait for shared; the shared report does', async () => {
    const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    const wait = outcome(manager.whenStage('shared'));
    report(child, { stage: 'waiting', holder: { role: 'import', pid: 78 } });
    expect(await wait.read()).toBe('pending');
    report(child, { stage: 'shared' });
    expect(await wait.read()).toBe('resolved');
  });

  it('a child that exits first rejects the wait naming the exit', async () => {
    const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    const wait = outcome(manager.whenStage('shared'));
    exitChild(child, 0);
    expect(await wait.read()).toBe(`rejected: ${EXITED_TEXT}`);
  });
});

/** A started child A with a pending whenStage, dropped by an emergency stop it outlives, then a started child B. */
async function twoChildren(): Promise<{ manager: BotManager; a: any; b: any; waitA: ReturnType<typeof outcome>; waitB: ReturnType<typeof outcome> }> {
  const { manager, child: a } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
  const waitA = outcome(manager.whenStage('shared'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stopping = manager.shutdown(true);
  await vi.advanceTimersByTimeAsync(6_000);
  await stopping;
  vi.useRealTimers();
  expect(a.exitCode).toBe(null);
  expect(manager.isRunning()).toBe(false);
  const { child: b } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }], manager);
  expect(b).not.toBe(a);
  const waitB = outcome(manager.whenStage('shared'));
  return { manager, a, b, waitA, waitB };
}

describe('stage waits of two children', () => {
  it("the new child's shared report resolves only its own wait; the old child's exit then rejects the old wait", async () => {
    const { b, a, waitA, waitB } = await twoChildren();
    report(b, { stage: 'shared' });
    expect(await waitB.read()).toBe('resolved');
    expect(await waitA.read()).toBe('pending');
    exitChild(a, 0);
    expect(await waitA.read()).toBe(`rejected: ${EXITED_TEXT}`);
  });

  it("the old child's exit rejects only its own wait; the new child's wait still resolves at its shared report", async () => {
    const { b, a, waitA, waitB } = await twoChildren();
    exitChild(a, 0);
    expect(await waitA.read()).toBe(`rejected: ${EXITED_TEXT}`);
    expect(await waitB.read()).toBe('pending');
    report(b, { stage: 'shared' });
    expect(await waitB.read()).toBe('resolved');
  });
});

describe('texts while the child has not opened its data files', () => {
  it('a request to a child that cannot read the lock names that, and says nothing was sent', async () => {
    const { manager } = await startedWith([{ stage: 'waiting', readCause: 'EACCES' }]);
    expect(await manager.getPanelList()).toEqual({ success: false, error: 'The bot cannot tell which process holds the data files (EACCES); nothing was sent to it.' });
  });

  it('a request to a child waiting for an unnamed process says so', async () => {
    const { manager } = await startedWith([{ stage: 'waiting' }]);
    expect(await manager.getPanelList()).toEqual({ success: false, error: 'The bot is waiting for another process to release the data files; nothing was sent to it. Try again once it has.' });
  });

  it('a read from a deposed child that named no holder answers that another process took the data files', async () => {
    const { manager } = await startedWith([{ stage: 'deposed' }]);
    expect(await manager.readGlobalData({ root: 'config' })).toEqual({
      ok: false, code: 'starting',
      error: 'Another process took the data files; nothing was saved. Stop that process or wait until it ends, then try again.',
    });
  });
});

describe("the web UI's own op while a child serves", () => {
  it('is refused as starting and does not run', async () => {
    const { manager } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    const run = vi.fn(async () => ({ ok: true }));
    expect(await manager.runLocalOp('populate', run)).toMatchObject({ ok: false, code: 'starting', error: ROUTE_TEXT.starting });
    expect(run).not.toHaveBeenCalled();
  });
});
