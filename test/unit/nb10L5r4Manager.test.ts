import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10: a local op that answered saved with nothing queued keeps that answer when another process takes the data
// files only after the op ended; and a child's exit drops its stage waits, leaving the next child's waits in place.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { checkWriterLock, releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks } from '../helpers/forkMock';
import { exitChild, freshWriterLock, quiet, report, resetForks, startedWith, tick } from '../helpers/nb10Rig';

const OTHER = 6161;
const EXITED_TEXT = 'The bot process exited before it opened the data files';

function outcome(p: Promise<unknown>): { read: (ms?: number) => Promise<string> } {
  let state = 'pending';
  p.then(() => { state = 'resolved'; }, (e: unknown) => { state = `rejected: ${e instanceof Error ? e.message : String(e)}`; });
  return { read: async (ms = 20) => { await tick(ms); return state; } };
}

beforeEach(() => {
  quiet();
  resetForks();
  freshWriterLock('webui', new Set([process.pid, OTHER]));
});

afterEach(() => {
  vi.useRealTimers();
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  vi.restoreAllMocks();
});

describe('a deposition that arrives after the local op ended', () => {
  it('leaves the answer saved when nothing was queued', async () => {
    const manager = new BotManager();
    let deposed: unknown = null;
    const run = async () => {
      // Hops until the chain closed the op's frame, then another process takes the lock at once.
      const poll = (): void => {
        if (inLocalOp()) {
          void Promise.resolve().then(poll);
          return;
        }
        fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
        deposed = checkWriterLock();
      };
      void Promise.resolve().then(poll);
      return { ok: true };
    };
    const answer = await manager.runLocalOp('test-op', run);
    expect(deposed).toMatchObject({ kind: 'deposed', holder: { pid: OTHER } });
    expect(answer).toEqual({ ok: true });
  });
});

describe('stage waits at a child exit', () => {
  it("the exited child's waits leave the list and the next child's wait stays and resolves", async () => {
    const { manager, child: a } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    const waitA = outcome(manager.whenStage('shared'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stopping = manager.shutdown(true);
    await vi.advanceTimersByTimeAsync(6_000);
    await stopping;
    vi.useRealTimers();
    expect(a.exitCode).toBe(null);
    const { child: b } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }], manager);
    expect(b).not.toBe(a);
    const waitB = outcome(manager.whenStage('shared'));
    expect((manager as any).stageWaiters.map((w: any) => w.child)).toEqual([a, b]);
    exitChild(a, 0);
    expect(await waitA.read()).toBe(`rejected: ${EXITED_TEXT}`);
    expect((manager as any).stageWaiters.map((w: any) => w.child)).toEqual([b]);
    report(b, { stage: 'shared' });
    expect(await waitB.read()).toBe('resolved');
    expect((manager as any).stageWaiters).toEqual([]);
  });

  it("a single child's exit leaves no wait behind", async () => {
    const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    const wait = outcome(manager.whenStage('shared'));
    expect((manager as any).stageWaiters).toHaveLength(1);
    exitChild(child, 0);
    expect(await wait.read()).toBe(`rejected: ${EXITED_TEXT}`);
    expect((manager as any).stageWaiters).toEqual([]);
  });
});
