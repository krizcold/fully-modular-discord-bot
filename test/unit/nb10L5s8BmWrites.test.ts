import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation survivors (chunk 8, botManager.ts): the answers of a guild write and a shared op, by route: the child,
// the local chain (its label at the web UI's exit, a deposition mid-op) and a refusal the op waits out or answers.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const hooks = vi.hoisted(() => ({
  guildWrite: null as null | ((payload: any) => Promise<any>),
  sharedOp: null as null | ((request: any) => Promise<any>),
}));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/ipcDataHandler', async orig => {
  const actual = await orig<typeof import('../../src/bot/internalSetup/utils/ipcDataHandler')>();
  return { ...actual, applyOperatorDataWrite: (payload: any) => (hooks.guildWrite ? hooks.guildWrite(payload) : actual.applyOperatorDataWrite(payload)) };
});
vi.mock('../../src/bot/internalSetup/utils/sharedOps', async orig => {
  const actual = await orig<typeof import('../../src/bot/internalSetup/utils/sharedOps')>();
  return { ...actual, applySharedOp: (request: any) => (hooks.sharedOp ? hooks.sharedOp(request) : actual.applySharedOp(request)) };
});

import { BotManager } from '../../src/webui/botManager';
import { checkWriterLock, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks } from '../helpers/forkMock';
import { exitChild, freshWriterLock, report, resetForks, sentTo, tick } from '../helpers/nb10Rig';
import { setBackendKind } from '../helpers/backendKind';

const managers: BotManager[] = [];
let errors: string[];

function manager(): BotManager {
  const m = new BotManager();
  (m as any).sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 10)));
  managers.push(m);
  return m;
}

async function startWith(stages: object[]): Promise<{ m: BotManager; child: any }> {
  const m = manager();
  forks.onFork = child => { setTimeout(() => { for (const data of stages) report(child, data); }, 1); };
  await m.start();
  forks.onFork = null;
  const child = forks.children.at(-1);
  await tick();
  return { m, child };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const lockNaming = (holder: object) => fs.writeFileSync(writerLockPath(), JSON.stringify({ start: null, at: Date.now(), ...holder }));
const write = (module: string) => ({ guildId: 'g1', module, filename: 'data.json', op: 'write' as const, contentJson: '{}' });

beforeEach(() => {
  resetForks();
  forks.holdExit = true;
  freshWriterLock('webui', new Set([process.pid, 5151]));
  hooks.guildWrite = null;
  hooks.sharedOp = null;
  errors = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
});

afterEach(async () => {
  for (const m of managers.splice(0)) m.cancelCrashRestart();
  forks.onFork = null;
  setBackendKind(null);
  hooks.guildWrite = null;
  hooks.sharedOp = null;
  vi.restoreAllMocks();
  fs.rmSync(writerLockPath(), { force: true });
});

describe('a guild write sent to the child that never answers', () => {
  it('an error that only looks like the exit is a failure, not a stop', async () => {
    const { m, child } = await startWith([{ stage: 'guild' }]);
    child.send = vi.fn(() => { throw new Error('the bot process exited before replying'); });
    expect(await m.writeGuildData(write('mod'))).toEqual({ ok: false, code: 'io-error', noAnswer: 'failed', error: 'the bot process exited before replying' });
    child.send = vi.fn(() => { throw new Error('bot process was stopped before replying, then again'); });
    expect(await m.writeGuildData(write('mod'))).toMatchObject({ code: 'io-error', noAnswer: 'failed' });
  });

  it('a throw that is no Error answers IPC failure', async () => {
    const { m, child } = await startWith([{ stage: 'guild' }]);
    child.send = vi.fn(() => { throw 'boom'; });
    expect(await m.writeGuildData(write('mod'))).toEqual({ ok: false, code: 'io-error', noAnswer: 'failed', error: 'IPC failure' });
  });
});

describe('a guild write with no child', () => {
  it('a Postgres bot answers bot-down and writes nothing', async () => {
    setBackendKind('postgres');
    const calls: any[] = [];
    hooks.guildWrite = async payload => { calls.push(payload); return { ok: true }; };
    expect(await manager().writeGuildData(write('mod'))).toEqual({ ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' });
    expect(calls).toEqual([]);
  });

  it('a file-backend bot runs it locally and names it at the exit while it still runs', async () => {
    setBackendKind('file');
    const m = manager();
    const held = deferred<any>();
    hooks.guildWrite = () => held.promise;
    const answer = m.writeGuildData(write('mod1'));
    await tick();
    await m.endLocalChain(5);
    expect(errors).toContain("[Main] Exiting while a local change is still running (write of mod1/data.json); can't confirm whether it was saved");
    held.resolve({ ok: true });
    await answer;
  });

  it('a write with no module is named by its file alone', async () => {
    setBackendKind('file');
    const m = manager();
    const held = deferred<any>();
    hooks.guildWrite = () => held.promise;
    const answer = m.writeGuildData(write(''));
    await tick();
    await m.endLocalChain(5);
    expect(errors).toContain("[Main] Exiting while a local change is still running (write of data.json); can't confirm whether it was saved");
    held.resolve({ ok: true });
    await answer;
  });

  it('a deposition mid-write answers held-elsewhere with no provider sentence', async () => {
    setBackendKind('file');
    const m = manager();
    const held = deferred<any>();
    hooks.guildWrite = () => held.promise;
    const answer = m.writeGuildData(write('mod'));
    await tick();
    lockNaming({ pid: 5151, role: 'bot' });
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
    held.resolve({ ok: false, code: 'failed', error: 'x' });
    expect(await answer).toEqual({
      ok: false, status: 503, code: 'held-elsewhere',
      error: "Another process took the data files (a bot process this web UI did not start, pid 5151) while your change was being saved; can't confirm whether it was saved. Reload to check before you try again.",
    });
  });
});

describe('a shared op that waits for a route', () => {
  it('a disk refusal is answered at once, even when the child opens its files during the wait', async () => {
    const { m, child } = await startWith([{ stage: 'waiting', cause: 'EROFS' }]);
    child.send = vi.fn((message: any) => {
      if (message?.requestId) setTimeout(() => child.emit('message', { requestId: message.requestId, data: { ok: true, result: 'child' } }), 1);
      return true;
    });
    setTimeout(() => report(child, { stage: 'shared' }), 40);
    const answer = await m.runSharedOp('nb10:op', {}, { routeWaitMs: 1000 });
    expect(answer).toMatchObject({ ok: false, code: 'disk' });
    await tick(60);
    expect(sentTo(child, 'shared:op')).toEqual([]);
  });

  it('a stop is waited out and the op then runs locally', async () => {
    hooks.sharedOp = async () => ({ ok: true, result: 'local' });
    const { m, child } = await startWith([{ stage: 'guild' }]);
    const stopping = m.shutdown();
    setTimeout(() => exitChild(child, 0), 40);
    expect(await m.runSharedOp('nb10:op', {}, { routeWaitMs: 1000 })).toEqual({ ok: true, result: 'local' });
    await stopping;
  });

  it('another holder is waited out and the op then runs locally', async () => {
    hooks.sharedOp = async () => ({ ok: true, result: 'local' });
    lockNaming({ pid: 5151, role: 'bot' });
    setTimeout(() => fs.rmSync(writerLockPath(), { force: true }), 40);
    expect(await manager().runSharedOp('nb10:op', {}, { routeWaitMs: 1000 })).toEqual({ ok: true, result: 'local' });
  });
});

describe('a shared op sent to the child', () => {
  it('a throw that is no Error answers IPC failure', async () => {
    const { m, child } = await startWith([{ stage: 'guild' }]);
    child.send = vi.fn(() => { throw 'boom'; });
    expect(await m.runSharedOp('nb10:op', {})).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'failed', error: 'IPC failure' });
  });

  it('a saved answer that lands during a stop stays as the child gave it', async () => {
    for (const data of [{ ok: true, answer: 'held' }, null]) {
      const { m, child } = await startWith([{ stage: 'guild' }]);
      const pending = m.runSharedOp('nb10:op', {});
      await tick();
      const sent = sentTo(child, 'shared:op').at(-1)!;
      const stopping = m.shutdown();
      expect(m.writerRoute('shared')).toMatchObject({ code: 'stopping' });
      child.emit('message', { requestId: sent.requestId, data });
      expect(await pending).toEqual(data);
      exitChild(child, 0);
      await stopping;
    }
  });
});
