import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 tests 7, 21 and 47 (their local-chain parts): with no bot process, the web UI's changes run one at a time under
// the writer lock, land or are cancelled before the lock is released, and stop at the web UI's exit.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, inLocalOp, ROUTE_TEXT } from '../../src/webui/botManager';
import { configureWriterLock, releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { flushAll, setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { dataPath } from '../../src/utils/dataRoot';
import { failFlushes, put, readJson } from '../helpers/configRig';
import path from 'path';
import { writeRawAtomic } from '../../src/bot/internalSetup/utils/dataManager';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { truthText, verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { ensureConfigPopulated, ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { ProcessLock } from '../../src/bot/internalSetup/utils/processLock';

const target = () => dataPath('global', 'nb10chain', 'x.json');
const write = (manager: BotManager, value: object, expectSha: string) =>
  manager.runSharedOp('global.write', { rel: 'nb10chain/x.json', contentJson: JSON.stringify(value), expectSha });

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setSharedWriteGate(() => inLocalOp());
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  configureWriterLock('webui');
  await flushAll();
  fs.rmSync(dataPath('global', 'nb10chain'), { recursive: true, force: true });
});

afterEach(() => {
  setSharedWriteGate(null);
  vi.restoreAllMocks();
});

describe('the local chain', () => {
  it('runs a change under the lock, answers once it landed, and releases the lock', async () => {
    const manager = new BotManager();
    const reply = await write(manager, { v: 1 }, 'absent');
    expect(reply).toEqual({ ok: true, result: true });
    expect(readJson(target())).toEqual({ v: 1 });
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(writerLockDepth()).toBe(0);
  });

  it('two changes queued together run one after the other under one take', async () => {
    const manager = new BotManager();
    put(target(), { v: 0 });
    const first = write(manager, { v: 1 }, shaOfRaw(fs.readFileSync(target(), 'utf8')));
    const second = write(manager, { v: 2 }, shaOfRaw(JSON.stringify({ v: 1 })));
    expect(fs.existsSync(writerLockPath())).toBe(true);
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(readJson(target())).toEqual({ v: 2 });
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('a write outside a chain op is refused by the gate', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writeRawAtomic } = await import('../../src/bot/internalSetup/utils/dataManager');
    expect(writeRawAtomic(target(), '{}')).toBe(false);
    expect(errors).toHaveBeenCalled();
  });

  it('a write the disk keeps refusing is cancelled after 8 s, named in the answer, and the lock is released', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const undo = failFlushes(target());
    try {
      const reply = await write(new BotManager(), { v: 1 }, 'absent');
      expect(reply).toMatchObject({ ok: false, code: 'disk' });
      expect(reply.error).toMatch(/^The disk did not take the write of x\.json \(ENOSPC\), so your change was not saved\. Check the disk, then try again\.$/);
      expect(queuedFilePaths()).not.toContain(target());
      expect(fs.existsSync(writerLockPath())).toBe(false);
    } finally {
      undo();
    }
  }, 20_000);

  it("the disk text names the errno of the path's last failed flush (EACCES), not a fixed one", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const undo = failFlushes(target(), 'EACCES');
    try {
      const reply = await write(new BotManager(), { v: 1 }, 'absent');
      expect(reply).toMatchObject({ ok: false, code: 'disk' });
      expect(reply.error).toBe('The disk did not take the write of x.json (EACCES), so your change was not saved. Check the disk, then try again.');
      expect(queuedFilePaths()).not.toContain(target());
      expect(errors.mock.calls.filter(c => String(c[0]).startsWith('[Data] Not saved')).map(c => String(c[0]))).toEqual([`[Data] Not saved: ${target()} (EACCES); the web UI dropped its write before releasing the data files' lock`]);
      expect(fs.existsSync(target())).toBe(false);
      expect(fs.existsSync(writerLockPath())).toBe(false);
    } finally {
      undo();
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
    await flushAll();
    expect(fs.existsSync(target())).toBe(false);
  }, 20_000);

  it('a write still queued with no failed flush is cancelled naming the 8 s bound and no bot (NB10 test 29)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setImmediate'] });
    let reply: any;
    try {
      reply = await new BotManager().runLocalOp('queued write', async () => {
        expect(writeRawAtomic(target(), '{"v":1}')).toBe(true);
        return { ok: true, result: true };
      });
    } finally {
      vi.useRealTimers();
    }
    const logs = errors.mock.calls.filter(c => String(c[0]).startsWith('[Data] Not saved')).map(c => String(c[0]));
    expect(logs).toEqual([`[Data] Not saved: ${target()} (not on disk within 8 s); the web UI dropped its write before releasing the data files' lock`]);
    expect(logs.some(l => /\bbot\b/i.test(l))).toBe(false);
    expect(reply).toMatchObject({ ok: false, code: 'disk' });
    expect(reply.error).toBe('The disk did not take the write of x.json (within 8 s), so your change was not saved. Check the disk, then try again.');
    expect(queuedFilePaths()).not.toContain(target());
    await flushAll();
    expect(fs.existsSync(target())).toBe(false);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('after beginExit a change is refused with the shutting-down text and the lock stays free', async () => {
    const manager = new BotManager();
    manager.beginExit();
    expect(await write(manager, { v: 1 }, 'absent')).toMatchObject({ ok: false, code: 'stopping', error: ROUTE_TEXT.exiting });
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('at the exit, queued changes are routed again and the one in progress finishes first', async () => {
    const manager = new BotManager();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
    const slow = (manager as any).enqueueLocal({ label: 'slow op', provider: false, run: async () => { await held; return { ok: true }; }, again: async () => ({ ok: false, code: 'again' }) });
    const queued = write(manager, { v: 1 }, 'absent');
    manager.beginExit();
    const ending = manager.endLocalChain();
    expect(await queued).toMatchObject({ ok: false, code: 'stopping', error: ROUTE_TEXT.exiting });
    release();
    await ending;
    expect(await slow).toMatchObject({ ok: true });
  });
});

/** A local op that writes these files under its own ledger and answers its verdict, as the boot populate does. */
function writesOp(manager: BotManager, files: string[]): Promise<any> {
  return manager.runLocalOp('two files', () => runSealed('console', null, null, async ledger => {
    for (const f of files) writeRawAtomic(f, JSON.stringify({ f: path.basename(f) }));
    const verdict = await verdictOf([ledger]);
    return verdict.ok ? { ok: true } : { ok: false, code: 'unconfirmed', answer: verdict.answer, partial: verdict.partial, error: truthText(verdict.answer, verdict.partial) };
  }));
}

/** The rename onto this path takes ms before it lands. */
function slowRename(absPath: string, ms: number): void {
  const real = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === absPath) await new Promise(resolve => setTimeout(resolve, ms));
    return real(from, to);
  }) as typeof fs.promises.rename);
}

describe('the land-or-cancel step (NB10 test 21)', () => {
  it('a write whose slow rename lands during the cancel wait answers ok, logs nothing as not saved, and is on disk', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    slowRename(target(), 9_000);
    const reply = await write(new BotManager(), { v: 9 }, 'absent');
    expect(reply).toMatchObject({ ok: true });
    expect(readJson(target())).toEqual({ v: 9 });
    expect(errors.mock.calls.some(c => String(c[0]).startsWith('[Data] Not saved'))).toBe(false);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  }, 30_000);

  it('two paths, one landing and one cancelled: disk, not saved in full, naming only the cancelled one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const landing = dataPath('global', 'nb10chain', 'landing.json');
    const refused = dataPath('global', 'nb10chain', 'refused.json');
    slowRename(landing, 9_000);
    const undo = failFlushes(refused);
    try {
      const reply = await writesOp(new BotManager(), [landing, refused]);
      expect(reply).toMatchObject({ ok: false, code: 'disk' });
      expect(reply.error).toBe('The disk did not take the write of refused.json (ENOSPC), so your change was not saved in full. Check the disk. What was saved: landing.json. Reload to see it before you try again: trying again could apply the saved part twice.');
      expect(reply.error).not.toContain('then try again');
      expect(readJson(landing)).toEqual({ f: 'landing.json' });
      expect(fs.existsSync(refused)).toBe(false);
      expect(queuedFilePaths()).not.toContain(refused);
    } finally {
      undo();
    }
  }, 30_000);

  it('the boot populate under ENOSPC releases the lock within 8 s plus the flush, logs config.json, and another process then takes the lock', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.rmSync(ROOT_CONFIG_PATH, { force: true });
    const undo = failFlushes(ROOT_CONFIG_PATH);
    try {
      const started = Date.now();
      const reply = await new BotManager().runLocalOp('config.json populate', () => runSealed('console', null, null, async ledger => {
        ensureConfigPopulated();
        const verdict = await verdictOf([ledger]);
        return verdict.ok ? { ok: true } : { ok: false, code: 'unconfirmed', answer: verdict.answer, partial: verdict.partial, error: truthText(verdict.answer, verdict.partial) };
      }));
      expect(Date.now() - started).toBeLessThan(12_000);
      expect(reply).toMatchObject({ ok: false });
      expect(errors.mock.calls.filter(c => String(c[0]).startsWith('[Data] Not saved')).map(c => String(c[0]))).toEqual([`[Data] Not saved: ${ROOT_CONFIG_PATH} (ENOSPC); the web UI dropped its write before releasing the data files' lock`]);
      expect(fs.existsSync(writerLockPath())).toBe(false);
      expect(fs.existsSync(ROOT_CONFIG_PATH)).toBe(false);
      const child = new ProcessLock({
        lockPath: writerLockPath(), takeoverPath: `${writerLockPath()}.takeover`, unparsableStaleMs: 10_000, takeoverStaleMs: 5_000,
        seams: { pid: () => 8181, alive: () => true, startOf: () => null, now: () => Date.now() },
      });
      expect(child.tryTake()).toEqual({ kind: 'taken' });
      child.release();
    } finally {
      undo();
    }
  }, 30_000);
});
