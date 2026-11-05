import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 decision 12 and the local chain's answers: what a local op answers after its land-or-cancel step, after a
// deposition, and when the disk drops its writes; caches reload only after an answer that is not ok.

const hooks = vi.hoisted(() => ({
  queued: null as null | string[],
  cancel: null as null | ((paths: string[]) => unknown[]),
  invalidations: 0,
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const actual = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...actual,
    queuedFilePaths: () => hooks.queued ?? actual.queuedFilePaths(),
    cancelQueued: (paths: string[], ...rest: any[]) => (hooks.cancel ? Promise.resolve(hooks.cancel(paths)) : (actual.cancelQueued as any)(paths, ...rest)),
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedOps', async orig => {
  const actual = await orig<typeof import('../../src/bot/internalSetup/utils/sharedOps')>();
  return { ...actual, invalidateSharedCaches: () => { hooks.invalidations += 1; actual.invalidateSharedCaches(); } };
});

import { BotManager } from '../../src/webui/botManager';
import { configureWriterLock, releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { carryWrites, type OpWrites } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { dataPath } from '../../src/utils/dataRoot';

const OTHER = 4242;
const live = new Set<number>([process.pid, OTHER]);
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

/** The op's answer, or 'no answer' when it has none within the bound. */
async function answerOf(promise: Promise<unknown>, boundMs = 1000): Promise<unknown> {
  return Promise.race([promise.then(value => ({ value })), tick(boundMs).then(() => 'no answer')]);
}

beforeEach(() => {
  hooks.queued = null;
  hooks.cancel = null;
  hooks.invalidations = 0;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  configureWriterLock('webui', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
});

describe('a local op that answers nothing', () => {
  it('answers nothing, reloads the caches and releases the lock', async () => {
    const manager = new BotManager();
    expect(await answerOf(manager.runLocalOp('empty', async () => undefined))).toEqual({ value: undefined });
    expect(hooks.invalidations).toBe(1);
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(writerLockDepth()).toBe(0);
  });
});

describe('the caches after a local op', () => {
  it('a saved answer leaves the caches as they are; one not saved reloads them', async () => {
    const manager = new BotManager();
    expect(await manager.runLocalOp('ok', async () => ({ ok: true, result: 1 }))).toEqual({ ok: true, result: 1 });
    expect(hooks.invalidations).toBe(0);
    expect(await manager.runLocalOp('refused', async () => ({ ok: false, code: 'conflict', error: 'x' }))).toMatchObject({ ok: false, code: 'conflict' });
    expect(hooks.invalidations).toBe(1);
  });
});

describe('a saved answer', () => {
  it('keeps the op fields and drops pending and note', async () => {
    const manager = new BotManager();
    const reply = await manager.runLocalOp('ok', async () => ({ ok: true, result: 7, sha: 'abc', pending: true, note: 'n' }));
    expect(reply).toEqual({ ok: true, result: 7, sha: 'abc' });
  });
});

describe('an unconfirmed answer with nothing left queued', () => {
  it.each(['pending', 'held', 'unavailable'])('answer %s: saved, since every write landed', async answer => {
    const manager = new BotManager();
    const reply = await manager.runLocalOp('u', async () => ({ ok: false, code: 'unconfirmed', answer, result: 3, error: 'e' }));
    expect(reply).toEqual({ ok: true, result: 3 });
  });

  it('another code with the same answer field stays as the op gave it', async () => {
    const manager = new BotManager();
    const given = { ok: false, code: 'conflict', answer: 'pending', error: 'The file changed.' };
    expect(await manager.runLocalOp('c', async () => given)).toEqual(given);
  });

  it('an unconfirmed answer of another kind stays as the op gave it', async () => {
    const manager = new BotManager();
    const given = { ok: false, code: 'unconfirmed', answer: 'node-stopping', error: 'e' };
    expect(await manager.runLocalOp('c', async () => given)).toEqual(given);
  });
});

describe('writes the disk dropped', () => {
  it('names every file and every errno, comma separated', async () => {
    const a = dataPath('global', 'nb10s9', 'a.json');
    const b = dataPath('global', 'nb10s9', 'b.json');
    hooks.queued = [a, b];
    hooks.cancel = paths => paths.map((p, i) => ({ path: p, outcome: 'cancelled', errno: i === 0 ? 'ENOSPC' : 'EIO' }));
    const manager = new BotManager();
    const reply = await manager.runLocalOp('two', async () => ({ ok: true, result: true }));
    expect(reply).toEqual({
      ok: false, status: 503, code: 'disk',
      error: 'The disk did not take the write of a.json, b.json (ENOSPC, EIO), so your change was not saved. Check the disk, then try again.',
    });
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(path.basename(a)).toBe('a.json');
  });
});

describe('an op the web UI was deposed during', () => {
  const holder = { role: 'bot', pid: OTHER };
  const lead = `Another process took the data files (a bot process this web UI did not start, pid ${OTHER}) while your change was being saved;`;
  const deposedRun = (manager: BotManager, reply: object) => async () => {
    (manager as any).chainWasDeposed(holder);
    return reply;
  };
  const writes = (over: Partial<OpWrites>): OpWrites => ({ tickets: [], refused: false, unknowable: false, landedBefore: false, ...over });

  it('a reply that carries no writes: can not confirm, reload to check', async () => {
    const manager = new BotManager();
    const reply = await manager.runLocalOp('d', deposedRun(manager, { ok: true, result: 1 }));
    expect(reply).toEqual({ ok: false, status: 503, code: 'held-elsewhere', error: `${lead} can't confirm whether it was saved. Reload to check before you try again.` });
  });

  it('a refused write after an earlier one landed: not saved in full', async () => {
    const manager = new BotManager();
    const reply = await manager.runLocalOp('d', deposedRun(manager, carryWrites({ ok: false, code: 'failed', error: 'x' }, writes({ refused: true, landedBefore: true }))));
    expect(reply).toEqual({
      ok: false, status: 503, code: 'held-elsewhere',
      error: `${lead} it was not saved in full. Can't confirm whether part of it was saved. Reload to check before you try again: trying again could apply a saved part twice.`,
    });
  });

  it('a refused write after guild and file writes landed: names the landed files only', async () => {
    const manager = new BotManager();
    const wsTicket = { kind: 'ws', seq: 1, set: { landedSeq: 1 }, guildId: '1', manager: null } as any;
    const fileTicket = { kind: 'file' as const, path: dataPath('global', 'nb10s9', 'a.json'), seq: 1, record: { landed: 1 } };
    const reply = await manager.runLocalOp('d', deposedRun(manager, carryWrites({ ok: false, code: 'failed', error: 'x' }, writes({ tickets: [wsTicket, fileTicket], refused: true }))));
    expect(reply).toEqual({
      ok: false, status: 503, code: 'held-elsewhere',
      error: `${lead} it was not saved in full. What was saved: a.json. Reload to see it before you try again: trying again could apply the saved part twice.`,
    });
  });

  it('a file write that did not land and is no longer queued: nothing was saved', async () => {
    const manager = new BotManager();
    const ticket = { kind: 'file' as const, path: dataPath('global', 'nb10s9', 'gone.json'), seq: 1, record: { landed: 0 } };
    const reply = await manager.runLocalOp('d', deposedRun(manager, carryWrites({ ok: true, result: 1 }, writes({ tickets: [ticket] }))));
    expect(reply).toEqual({ ok: false, status: 503, code: 'held-elsewhere', error: `${lead} nothing was saved.` });
  });
});
