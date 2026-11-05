import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 tests 27 and 39 (BotManager's part): a child that reports `waiting` is shown as waiting for the data files, its
// start is not logged as a successful one, and the health clock (index.ts awaits whenStage('shared')) starts only at
// `shared`; a child that exits first starts none.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { forks } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, quiet, report, resetForks, tick } from '../helpers/nb10Rig';

beforeEach(() => {
  quiet();
  resetForks();
  freshWriterLock('webui');
});

afterEach(() => {
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

/** A start whose child reports these stages before BotManager reads its state. */
async function start(stages: object[]): Promise<{ manager: BotManager; child: any; result: any; broadcast: ReturnType<typeof vi.fn> }> {
  const manager = new BotManager();
  const broadcast = vi.fn();
  manager.setWebSocketManager({ broadcast } as any);
  forks.holdExit = true;
  forks.onFork = child => { setTimeout(() => { for (const s of stages) report(child, s); }, 1); };
  const result = await manager.start();
  forks.onFork = null;
  return { manager, child: forks.children.at(-1), result, broadcast };
}

describe('a child waiting for the data files (test 27)', () => {
  it('shows waiting-for-data-files with the holder, logs the waiting line and emits bot:status, not a successful start', async () => {
    const { manager, result, broadcast } = await start([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    expect(result).toEqual({ success: true, waiting: true, waitingFor: { role: 'webui', pid: 77 } });
    const status = manager.getStatus();
    expect(status.mode).toBe('waiting-for-data-files');
    expect(status.dataFiles).toEqual({ waitingFor: { role: 'webui', pid: 77 } });
    const lines = logged(vi.mocked(console.log));
    expect(lines).toContain('[BotManager] The bot process started and waits for the web UI (pid 77) to release the data files');
    expect(lines).not.toContain('[BotManager] Bot started successfully');
    const events = broadcast.mock.calls.map(c => c[0]);
    expect(events).toContain('bot:status');
    expect(events).not.toContain('bot:startup');
  });

  it('a child that cannot create the lock shows cannotLock with the errno', async () => {
    const { manager, result } = await start([{ stage: 'waiting', cause: 'EROFS' }]);
    expect(result).toEqual({ success: true, waiting: true, cannotLock: 'EROFS' });
    expect(manager.getStatus().dataFiles).toEqual({ cannotLock: 'EROFS' });
    expect(logged(vi.mocked(console.log))).toContain('[BotManager] The bot process started and waits for the data disk to take writes (EROFS)');
  });

  it('once the child reports shared and guild, the status no longer shows a wait', async () => {
    const { manager, child } = await start([{ stage: 'waiting', holder: { role: 'import', pid: 31 } }]);
    report(child, { stage: 'shared' });
    report(child, { stage: 'guild' });
    expect(manager.getStatus().dataFiles).toBe(null);
    expect(manager.getStatus().mode).not.toBe('waiting-for-data-files');
  });
});

describe('the health clock (test 39)', () => {
  it('whenStage(shared) resolves only at the shared report', async () => {
    const { manager, child } = await start([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    let validated = false;
    void manager.whenStage('shared').then(() => { validated = true; });
    await tick(20);
    expect(validated).toBe(false);
    report(child, { stage: 'shared' });
    await tick();
    expect(validated).toBe(true);
  });

  it('a child that exits before shared rejects the wait, so no validation starts', async () => {
    const { manager, child } = await start([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    const outcome = manager.whenStage('shared').then(() => 'validated', () => 'none');
    exitChild(child, 0);
    expect(await outcome).toBe('none');
  });
});

describe('a child that cannot read the lock file', () => {
  it('reports cannotRead, and a write route answers that the bot cannot tell which process holds the data files', async () => {
    const { manager, result } = await start([{ stage: 'waiting', readCause: 'EACCES' }]);
    expect(result).toMatchObject({ success: true, cannotRead: 'EACCES' });
    const route = manager.writerRoute('shared') as any;
    expect(route.ok).toBe(false);
    expect(route.error).toContain('cannot tell which process holds the data files');
    expect(route.error).toContain('EACCES');
    expect(route.error).not.toContain('does not take writes');
  });
});
