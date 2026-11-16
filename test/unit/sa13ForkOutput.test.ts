import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 survivors, chunk 13: the bot process is forked with its output piped to the web UI, so the operator's log view
// holds what the bot prints and the start sees the bot log in. The fork stand-in follows Node's fork: without silent
// the child's stdout and stderr are the parent's own, and the child has no streams to read.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const out = vi.hoisted(() => ({ terminal: [] as string[] }));

vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn((_entry: string, _args: string[], options: { silent?: boolean }) => {
    const child = fakeFork();
    if (!options?.silent) {
      child.stdout = null;
      child.stderr = null;
    }
    return child;
  });
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { releaseWriterLock, writerLockDepth } from '../../src/bot/internalSetup/utils/writerLock';
import { forkLogin, forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, quiet, resetForks, tick } from '../helpers/nb10Rig';

function print(child: any, stream: 'stdout' | 'stderr', text: string): void {
  if (child[stream]) child[stream].emit('data', Buffer.from(text));
  else out.terminal.push(text);
}

beforeEach(() => {
  quiet();
  resetForks();
  forkLogin.on = false;
  forkStage.stages = ['shared', 'guild'];
  out.terminal.length = 0;
  freshWriterLock('webui');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  while (writerLockDepth() > 0) releaseWriterLock();
  vi.restoreAllMocks();
});

describe("the bot process's output", () => {
  it("reaches the web UI's log, and the start sees the login", async () => {
    const manager = new BotManager();
    forks.onFork = child => {
      setTimeout(() => {
        print(child, 'stdout', 'Logged in as test#0001!\n');
        print(child, 'stdout', '[Module] sa13 hello\n');
        print(child, 'stderr', '[Module] sa13 boom\n');
      }, 5);
    };
    const begun = Date.now();
    const started = manager.start();
    for (let i = 0; i < 200 && manager.getLogs().current.length < 3; i++) await tick(5);
    expect(out.terminal).toEqual([]);
    expect(manager.getLogs().current).toEqual(['Logged in as test#0001!\n', '[Module] sa13 hello\n', '[ERROR] [Module] sa13 boom\n']);
    expect(await started).toEqual({ success: true });
    expect(Date.now() - begun).toBeLessThan(4_000);
  });
});
