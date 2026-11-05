import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 42 (the lock's part): a disk that refuses writes answers unwritable, never a throw or an empty lock.

const h = vi.hoisted(() => ({
  failCreate: null as string | null,
  failWrite: null as string | null,
  failUnlink: null as string | null,
  failCleanup: false,
}));

vi.mock('fs', async (orig) => {
  const real = await orig<any>();
  const isLock = (file: unknown) => path.basename(String(file)) === '.writer.lock';
  const lockFds = new Set<number>();
  const wrapped = {
    ...real,
    openSync: (file: any, flags: any, ...rest: any[]) => {
      if (isLock(file) && flags === 'wx' && h.failCreate) throw Object.assign(new Error(`${h.failCreate}: refused`), { code: h.failCreate });
      const fd = real.openSync(file, flags, ...rest);
      if (isLock(file) && flags === 'wx') lockFds.add(fd);
      return fd;
    },
    writeSync: (fd: any, ...rest: any[]) => {
      if (lockFds.has(fd) && h.failWrite) throw Object.assign(new Error(`${h.failWrite}: refused`), { code: h.failWrite });
      return real.writeSync(fd, ...rest);
    },
    closeSync: (fd: any) => {
      lockFds.delete(fd);
      return real.closeSync(fd);
    },
    unlinkSync: (file: any) => {
      if (isLock(file) && h.failUnlink) throw Object.assign(new Error(`${h.failUnlink}: refused`), { code: h.failUnlink });
      if (isLock(file) && h.failCleanup) throw Object.assign(new Error('EIO: refused'), { code: 'EIO' });
      return real.unlinkSync(file);
    },
  };
  return { ...wrapped, default: wrapped };
});

import fs from 'fs';
import { ProcessLock } from '../../src/bot/internalSetup/utils/processLock';
import { dataPath } from '../../src/utils/dataRoot';

const LOCK = dataPath('.writer.lock');
const live = new Set<number>([101]);
let clock = Date.now();
const lock = (pid = 101) => new ProcessLock({
  lockPath: LOCK, takeoverPath: `${LOCK}.takeover`, unparsableStaleMs: 10_000, takeoverStaleMs: 5_000,
  seams: { pid: () => pid, alive: p => live.has(p), startOf: () => null, now: () => clock },
});

beforeEach(() => {
  h.failCreate = h.failWrite = h.failUnlink = null;
  h.failCleanup = false;
  fs.rmSync(LOCK, { force: true });
  fs.rmSync(`${LOCK}.takeover`, { force: true });
  clock = Date.now();
});

describe('a lock take on a disk that refuses writes', () => {
  it('EROFS on the create answers unwritable with the errno', () => {
    h.failCreate = 'EROFS';
    expect(lock().tryTake()).toMatchObject({ kind: 'unwritable', errno: 'EROFS' });
    expect(fs.existsSync(LOCK)).toBe(false);
  });

  it('ENOSPC on writing the holder text answers unwritable and leaves no lock file', () => {
    h.failWrite = 'ENOSPC';
    expect(lock().tryTake()).toMatchObject({ kind: 'unwritable', errno: 'ENOSPC' });
    expect(fs.existsSync(LOCK)).toBe(false);
  });

  it('when the cleanup unlink fails too, the empty file is taken over after 10 s', () => {
    h.failWrite = 'ENOSPC';
    h.failCleanup = true;
    expect(lock().tryTake()).toMatchObject({ kind: 'unwritable' });
    expect(fs.readFileSync(LOCK, 'utf8')).toBe('');
    h.failWrite = null;
    h.failCleanup = false;
    const other = lock(102);
    clock = fs.statSync(LOCK).mtimeMs + 1000;
    expect(other.tryTake()).toEqual({ kind: 'held', holder: null });
    clock = fs.statSync(LOCK).mtimeMs + 11_000;
    expect(other.tryTake()).toEqual({ kind: 'taken' });
  });

  it('EROFS on unlinking a stale lock answers unwritable', () => {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 999, start: null, at: 1 }));
    h.failUnlink = 'EROFS';
    expect(lock().tryTake()).toMatchObject({ kind: 'unwritable', errno: 'EROFS' });
  });
});

describe('a disk that refuses the writer lock, in each process', () => {
  it('a bot child reports the cause, logs the errno at once, retries every 1 s and takes the lock once the disk takes writes', async () => {
    const { configureWriterLock, takeWriterLockForBoot, releaseWriterLock, writerLockDepth } = await import('../../src/bot/internalSetup/utils/writerLock');
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: any[] = [];
    (process as any).send = (message: unknown) => { sent.push(message); return true; };
    try {
      configureWriterLock('bot', { pid: () => process.pid, alive: () => true, startOf: () => null, now: () => Date.now() });
      h.failCreate = 'EROFS';
      const waits: number[] = [];
      await takeWriterLockForBoot(async ms => {
        if (waits.length === 0) expect(warns.mock.calls.map(c => String(c[0]))).toEqual([`[Data] Cannot create ${LOCK} (EROFS); the bot waits until /data takes writes`]);
        waits.push(ms);
        if (waits.length === 3) h.failCreate = null;
      }, () => 0);
      expect(sent).toEqual([{ type: 'data:writer', data: { stage: 'waiting', cause: 'EROFS' } }, { type: 'data:writer', data: { stage: 'opening' } }]);
      expect(waits).toEqual([1000, 1000, 1000]);
      expect(writerLockDepth()).toBe(1);
      expect(JSON.parse(fs.readFileSync(LOCK, 'utf8'))).toMatchObject({ pid: process.pid, role: 'bot' });
      releaseWriterLock();
    } finally {
      delete (process as any).send;
      vi.restoreAllMocks();
    }
  });

  it('the web UI answers 503 disk with the errno, and its own change (the boot populate) runs nothing', async () => {
    const { configureWriterLock } = await import('../../src/bot/internalSetup/utils/writerLock');
    const { BotManager } = await import('../../src/webui/botManager');
    configureWriterLock('webui', { pid: () => process.pid, alive: () => true, startOf: () => null, now: () => Date.now() });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.failCreate = 'EROFS';
    const manager = new BotManager();
    expect(manager.writerRoute('shared')).toMatchObject({
      ok: false, status: 503, code: 'disk',
      error: `The data disk does not take writes (${LOCK}: EROFS); nothing was saved. Check the disk, then try again.`,
    });
    let ran = false;
    expect(await manager.runLocalOp('config.json populate', async () => { ran = true; return { ok: true }; })).toMatchObject({ code: 'disk' });
    expect(ran).toBe(false);
    expect(fs.existsSync(LOCK)).toBe(false);
    vi.restoreAllMocks();
  });
});
