import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 7: the local chain holds the writer lock while an op runs and through its land-or-cancel step, releases it
// when the chain empties, runs queued ops under one take, and hands queued ops to a child forked meanwhile.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, inLocalOp, ROUTE_TEXT } from '../../src/webui/botManager';
import { flushAll, setSharedWriteGate, writeRawAtomic } from '../../src/bot/internalSetup/utils/dataManager';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { failFlushes, readJson } from '../helpers/configRig';
import { forks } from '../helpers/forkMock';
import { exitChild, freshWriterLock, quiet, resetForks, sentTo, startedWith } from '../helpers/nb10Rig';

const target = (name = 'x.json') => dataPath('global', 'nb10release', name);
const write = (manager: BotManager, name: string, value: object, options?: { routeWaitMs?: number }) =>
  manager.runSharedOp('global.write', { rel: `nb10release/${name}`, contentJson: JSON.stringify(value), expectSha: 'absent' }, options);
const lockHolder = () => (fs.existsSync(writerLockPath()) ? JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')) : null);

/** Counts the creates of the writer lock file (each take from depth 0 makes one). */
function countTakes(): { count: number; undo: () => void } {
  const seen = { count: 0, undo: () => undefined as void };
  const real = fs.openSync;
  const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: any, flags: any, ...rest: any[]) => {
    if (String(p) === writerLockPath() && flags === 'wx') seen.count++;
    return (real as any)(p, flags, ...rest);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  seen.undo = () => { spy.mockRestore(); syncBuiltinESMExports(); };
  return seen;
}

/** An op the test holds in progress in the chain, under a real take. */
function heldOp(manager: BotManager): { reply: Promise<any>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
  const reply = (manager as any).enqueueLocal({
    label: 'held op', provider: false,
    run: async () => { await held; return { ok: true }; },
    again: async () => ({ ok: false, code: 'again' }),
  });
  return { reply, release };
}

beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  setSharedWriteGate(() => inLocalOp());
  await flushAll();
  fs.rmSync(dataPath('global', 'nb10release'), { recursive: true, force: true });
});

afterEach(() => {
  setSharedWriteGate(null);
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

describe('the local chain and the writer lock', () => {
  it('holds the lock while an op runs and releases it when the chain empties', async () => {
    const manager = new BotManager();
    const { reply, release } = heldOp(manager);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(lockHolder()).toMatchObject({ pid: process.pid, role: 'webui' });
    release();
    expect(await reply).toEqual({ ok: true });
    expect(lockHolder()).toBe(null);
  });

  it('a session file still queued does not keep the hold', async () => {
    const manager = new BotManager();
    const session = dataPath('_sessions', 'nb10release.json');
    const undo = failFlushes(session);
    try {
      const reply = await (manager as any).runLocalOp('session write', async () => ({ ok: writeRawAtomic(session, '{}') }));
      expect(reply).toEqual({ ok: true });
      expect(queuedFilePaths()).toContain(session);
      expect(lockHolder()).toBe(null);
    } finally {
      undo();
      await flushAll();
    }
  });

  it('two ops queued together run one after the other under one take', async () => {
    const manager = new BotManager();
    const takes = countTakes();
    try {
      const first = write(manager, 'a.json', { v: 1 });
      const second = write(manager, 'b.json', { v: 2 });
      expect(await first).toMatchObject({ ok: true });
      expect(await second).toMatchObject({ ok: true });
    } finally {
      takes.undo();
    }
    expect(takes.count).toBe(1);
    expect(readJson(target('a.json'))).toEqual({ v: 1 });
    expect(readJson(target('b.json'))).toEqual({ v: 2 });
    expect(lockHolder()).toBe(null);
  });

  it('a child forked while an op runs gets the queued ops; the webhook waits 5 s; the lock stays until the op ended', async () => {
    const manager = new BotManager();
    const { reply, release } = heldOp(manager);
    const a = write(manager, 'a.json', { v: 1 });
    const b = write(manager, 'b.json', { v: 2 });
    const queuedAt = Date.now();
    const hook = manager.runSharedOp('payment.webhook', { providerId: 'dummy', body: '', signature: '', headers: {} }, { routeWaitMs: 5000 });
    const { child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: process.pid } }], manager);
    const answers = await Promise.all([a, b]);
    for (const answer of answers) {
      expect(answer).toMatchObject({ ok: false, code: 'starting' });
      // The ops leave the chain at the fork, before the child's first report, so they get the starting text.
      expect(answer.error).toBe(ROUTE_TEXT.starting);
    }
    const hookAnswer = await hook;
    expect(hookAnswer).toMatchObject({ ok: false, code: 'starting' });
    expect(Date.now() - queuedAt).toBeGreaterThanOrEqual(4_900);
    expect(fs.existsSync(target('a.json'))).toBe(false);
    expect(fs.existsSync(target('b.json'))).toBe(false);
    expect(sentTo(child, 'shared:op')).toEqual([]);
    // The child's take waits on this lock: it stays until the op in progress ended its land-or-cancel step.
    expect(lockHolder()).toMatchObject({ pid: process.pid, role: 'webui' });
    release();
    expect(await reply).toEqual({ ok: true });
    expect(lockHolder()).toBe(null);
  }, 15_000);
});
