import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 writerLock.ts: the configure guard, a take while deposed, the 5 s check's life, the retry of a failed release,
// the release at exit (decision 2: only with nothing queued and nothing on the wire) and the holder read. A read of the
// lock file can be made to fail, and the queue counters the exit release reads can be set.

const h = vi.hoisted(() => ({
  readErrors: [] as unknown[],
  queued: null as number | null,
  wire: null as boolean | null,
}));

vi.mock('fs', async orig => {
  const real = await orig<any>();
  const wrapped = {
    ...real,
    readFileSync: (file: any, ...rest: any[]) => {
      if (h.readErrors.length > 0 && typeof file === 'string' && path.basename(file) === '.writer.lock') throw h.readErrors.shift();
      return real.readFileSync(file, ...rest);
    },
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    queuedFileWrites: () => (h.queued ?? real.queuedFileWrites()),
    fileFlushOnTheWire: () => (h.wire ?? real.fileFlushOnTheWire()),
  };
});

import {
  checkWriterLock, configureWriterLock, deposedHolder, readWriterHolder, releaseWriterLock, releaseWriterLockAtExit,
  takeWriterLock, WRITER_CHECK_MS, writerLockDepth, writerLockPath,
} from '../../src/bot/internalSetup/utils/writerLock';
import { flushAll, sharedWritesClosedLost } from '../../src/bot/internalSetup/utils/dataManager';
import type { LockSeams } from '../../src/bot/internalSetup/utils/processLock';

const OTHER = 4747;
const live = new Set<number>([process.pid, OTHER]);
const seams: LockSeams = { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() };
const fail = (code: string) => Object.assign(new Error(`${code}: refused`), { code });
const lines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map(c => c.map(String).join(' '));

let logs: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;

function clearHold(): void {
  h.readErrors = [];
  h.queued = null;
  h.wire = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  // A fresh take ends a pending release retry and forgets a deposition; its release leaves no file.
  takeWriterLock();
  releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
}

beforeEach(async () => {
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.readErrors = [];
  h.queued = null;
  h.wire = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  configureWriterLock('bot', seams);
  clearHold();
  await flushAll();
  logs.mockClear();
  errors.mockClear();
});

afterEach(async () => {
  clearHold();
  vi.useRealTimers();
  await flushAll();
  vi.restoreAllMocks();
});

const fakeIntervals = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
const lockText = () => fs.readFileSync(writerLockPath(), 'utf8');

describe('configuring the writer lock', () => {
  it('is refused while this process holds the lock, and the hold stays', () => {
    expect(takeWriterLock().kind).toBe('taken');
    expect(() => configureWriterLock('bot', seams)).toThrow('[Data] The writer lock is configured while it is held');
    expect(writerLockDepth()).toBe(1);
    expect(JSON.parse(lockText()).pid).toBe(process.pid);
  });
});

describe('a take after another process deposed this one', () => {
  it('that finds the other holder still there keeps the deposition and the closed writes', async () => {
    expect(takeWriterLock().kind).toBe('taken');
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'webui', at: Date.now() }));
    expect(checkWriterLock()).toEqual({ kind: 'deposed', holder: expect.objectContaining({ pid: OTHER }) });
    expect(sharedWritesClosedLost()).toBe(true);

    expect(takeWriterLock()).toEqual({ kind: 'held', holder: expect.objectContaining({ pid: OTHER, role: 'webui' }) });
    expect(deposedHolder()?.pid).toBe(OTHER);
    expect(sharedWritesClosedLost()).toBe(true);
    expect(checkWriterLock()).toEqual({ kind: 'deposed', holder: expect.objectContaining({ pid: OTHER }) });
    expect(writerLockDepth()).toBe(0);
    expect(JSON.parse(lockText()).pid).toBe(OTHER);
    await flushAll();

    // The other process ends; this one takes the lock again and writes again.
    fs.unlinkSync(writerLockPath());
    expect(takeWriterLock().kind).toBe('taken');
    expect(deposedHolder()).toBeNull();
    expect(sharedWritesClosedLost()).toBe(false);
  });
});

describe('the 5 s check', () => {
  it('keeps running while a nested hold remains and re-creates a deleted lock file', () => {
    fakeIntervals();
    expect(takeWriterLock().kind).toBe('taken');
    const written = lockText();
    expect(takeWriterLock().kind).toBe('taken');
    releaseWriterLock();
    expect(writerLockDepth()).toBe(1);
    fs.unlinkSync(writerLockPath());
    vi.advanceTimersByTime(WRITER_CHECK_MS);
    expect(lockText()).toBe(written);
    expect(lines(errors).some(l => l.startsWith(`[Data] ${writerLockPath()} was removed while this process held it; re-created it.`))).toBe(true);
  });

  it('ends with the last release, so nothing checks a lock this process no longer holds', () => {
    fakeIntervals();
    const base = vi.getTimerCount();
    expect(takeWriterLock().kind).toBe('taken');
    expect(vi.getTimerCount()).toBe(base + 1);
    releaseWriterLock();
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(vi.getTimerCount()).toBe(base);
  });
});

describe('the retry of a release whose removal failed', () => {
  it('removes the file on a later try and logs it once', () => {
    fakeIntervals();
    const base = vi.getTimerCount();
    expect(takeWriterLock().kind).toBe('taken');
    const written = lockText();
    h.readErrors = [fail('EACCES')];
    releaseWriterLock();
    expect(writerLockDepth()).toBe(0);
    expect(lockText()).toBe(written);
    expect(lines(errors)).toEqual([`[Data] Could not remove ${writerLockPath()} (EACCES); it still names this process, so no other process can take the data files. Trying again in 5 s`]);
    expect(vi.getTimerCount()).toBe(base + 1);

    vi.advanceTimersByTime(WRITER_CHECK_MS);
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(lines(logs)).toEqual([`[Data] Removed ${writerLockPath()} on a later try`]);
    expect(vi.getTimerCount()).toBe(base);

    vi.advanceTimersByTime(3 * WRITER_CHECK_MS);
    expect(lines(logs)).toEqual([`[Data] Removed ${writerLockPath()} on a later try`]);
    expect(lines(errors)).toHaveLength(1);
  });

  it('logs a later failure only when its errno differs from the one last logged', () => {
    fakeIntervals();
    expect(takeWriterLock().kind).toBe('taken');
    const written = lockText();
    h.readErrors = [fail('EACCES'), fail('EACCES'), fail('EPERM'), fail('EPERM')];
    releaseWriterLock();
    errors.mockClear();

    vi.advanceTimersByTime(WRITER_CHECK_MS);
    expect(lines(errors)).toEqual([]);
    vi.advanceTimersByTime(WRITER_CHECK_MS);
    expect(lines(errors)).toEqual([`[Data] Could not remove ${writerLockPath()} (EPERM); trying again in 5 s`]);
    vi.advanceTimersByTime(WRITER_CHECK_MS);
    expect(lines(errors)).toEqual([`[Data] Could not remove ${writerLockPath()} (EPERM); trying again in 5 s`]);
    expect(lockText()).toBe(written);
    expect(lines(logs)).toEqual([]);

    vi.advanceTimersByTime(WRITER_CHECK_MS);
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(lines(logs)).toEqual([`[Data] Removed ${writerLockPath()} on a later try`]);
  });

  it('ends at a later take, so it claims no removal the later release made', () => {
    fakeIntervals();
    const base = vi.getTimerCount();
    expect(takeWriterLock().kind).toBe('taken');
    h.readErrors = [fail('EACCES')];
    releaseWriterLock();
    expect(takeWriterLock().kind).toBe('taken');
    releaseWriterLock();
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(vi.getTimerCount()).toBe(base);
    vi.advanceTimersByTime(3 * WRITER_CHECK_MS);
    expect(lines(logs).filter(l => l.includes('on a later try'))).toEqual([]);
  });

  it('ends once the lock is configured anew and leaves the file it could not remove', () => {
    fakeIntervals();
    const base = vi.getTimerCount();
    expect(takeWriterLock().kind).toBe('taken');
    const written = lockText();
    h.readErrors = [fail('EACCES')];
    releaseWriterLock();
    configureWriterLock('bot', seams);
    vi.advanceTimersByTime(WRITER_CHECK_MS);
    expect(vi.getTimerCount()).toBe(base);
    vi.advanceTimersByTime(3 * WRITER_CHECK_MS);
    expect(lockText()).toBe(written);
    expect(lines(logs)).toEqual([]);
  });

  it('does not keep the process alive', () => {
    const made: Array<{ ms: unknown; timer: NodeJS.Timeout }> = [];
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const timer = realSetInterval(fn, ms, ...rest) as unknown as NodeJS.Timeout;
      made.push({ ms, timer });
      return timer;
    }) as any);
    expect(takeWriterLock().kind).toBe('taken');
    h.readErrors = [fail('EACCES')];
    const before = made.length;
    releaseWriterLock();
    expect(made.length).toBe(before + 1);
    const retry = made[made.length - 1];
    expect(retry.ms).toBe(WRITER_CHECK_MS);
    expect(retry.timer.hasRef()).toBe(false);
  });
});

describe('the release at exit', () => {
  it('with nothing queued releases every level, removes the file and logs nothing', () => {
    expect(takeWriterLock().kind).toBe('taken');
    expect(takeWriterLock().kind).toBe('taken');
    releaseWriterLockAtExit();
    expect(writerLockDepth()).toBe(0);
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(lines(errors)).toEqual([]);
  });

  it('stops the 5 s check', () => {
    fakeIntervals();
    const base = vi.getTimerCount();
    expect(takeWriterLock().kind).toBe('taken');
    releaseWriterLockAtExit();
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(vi.getTimerCount()).toBe(base);
  });

  it('leaves the lock for takeover while a write is queued', () => {
    expect(takeWriterLock().kind).toBe('taken');
    const written = lockText();
    h.queued = 1;
    h.wire = false;
    releaseWriterLockAtExit();
    expect(writerLockDepth()).toBe(1);
    expect(lockText()).toBe(written);
    expect(lines(errors)).toEqual([]);
  });

  it('leaves the lock for takeover while a flush is on the wire', () => {
    expect(takeWriterLock().kind).toBe('taken');
    const written = lockText();
    h.queued = 0;
    h.wire = true;
    releaseWriterLockAtExit();
    expect(writerLockDepth()).toBe(1);
    expect(lockText()).toBe(written);
    expect(lines(errors)).toEqual([]);
  });

  it('logs a removal that failed and names the takeover', () => {
    expect(takeWriterLock().kind).toBe('taken');
    const written = lockText();
    h.readErrors = [fail('EACCES')];
    releaseWriterLockAtExit();
    expect(writerLockDepth()).toBe(0);
    expect(lockText()).toBe(written);
    expect(lines(errors)).toEqual([`[Data] Could not remove ${writerLockPath()} at exit (EACCES); the next process takes it over once this one has ended`]);
  });

  it('with nothing held leaves a pending release retry to remove the file', () => {
    fakeIntervals();
    expect(takeWriterLock().kind).toBe('taken');
    h.readErrors = [fail('EACCES')];
    releaseWriterLock();
    releaseWriterLockAtExit();
    expect(fs.existsSync(writerLockPath())).toBe(true);
    vi.advanceTimersByTime(WRITER_CHECK_MS);
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(lines(logs)).toEqual([`[Data] Removed ${writerLockPath()} on a later try`]);
  });
});

describe('the holder read', () => {
  it('answers free when no lock file exists', () => {
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(readWriterHolder()).toEqual({ kind: 'free' });
  });

  it('answers unreadable with the errno of a read that failed', () => {
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'webui', at: 1 }));
    h.readErrors = [fail('EACCES')];
    expect(readWriterHolder()).toEqual({ kind: 'unreadable', errno: 'EACCES' });
    expect(readWriterHolder()).toEqual({ kind: 'held', holder: { pid: OTHER, start: null, role: 'webui', at: 1 } });
  });

  it('answers unreadable EIO when the read fails with no error value', () => {
    h.readErrors = [undefined];
    expect(readWriterHolder()).toEqual({ kind: 'unreadable', errno: 'EIO' });
  });
});
