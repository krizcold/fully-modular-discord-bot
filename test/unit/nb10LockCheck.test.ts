import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  checkWriterLock, configureWriterLock, onDeposed, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath,
} from '../../src/bot/internalSetup/utils/writerLock';
import { syncBuiltinESMExports } from 'module';
import { flushAll, saveDataTracked, sharedWritesClosedLost } from '../../src/bot/internalSetup/utils/dataManager';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

// NB10 test 26 (the check's part): the holder reads the lock file every 5 s and before each op, against the text it wrote.

const live = new Set<number>([process.pid, 4242]);
const deposed: number[] = [];
onDeposed(holder => deposed.push(holder.pid));

beforeEach(() => {
  deposed.length = 0;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  configureWriterLock('webui', { pid: () => process.pid, alive: p => live.has(p), startOf: p => `start-${p}`, now: () => Date.now() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (writerLockDepth() > 0) releaseWriterLock();
});

describe('the writer lock check of a holder', () => {
  it('re-creates a deleted lock file with the text it wrote, and logs it', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(takeWriterLock().kind).toBe('taken');
    const written = fs.readFileSync(writerLockPath(), 'utf8');
    fs.unlinkSync(writerLockPath());
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(fs.readFileSync(writerLockPath(), 'utf8')).toBe(written);
    expect(errors.mock.calls.some(c => String(c[0]).includes('was removed while this process held it; re-created it'))).toBe(true);
  });

  it('runs the check every 5 s while held', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    takeWriterLock();
    fs.unlinkSync(writerLockPath());
    vi.advanceTimersByTime(5_000);
    expect(fs.existsSync(writerLockPath())).toBe(true);
  });

  it('a read error or a text that does not parse leaves the holder writing, logged once per cause', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    takeWriterLock();
    fs.unlinkSync(writerLockPath());
    fs.mkdirSync(writerLockPath());
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(errors.mock.calls.filter(c => String(c[0]).includes('Cannot read')).length).toBe(1);
    fs.rmdirSync(writerLockPath());
    fs.writeFileSync(writerLockPath(), 'not json');
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(sharedWritesClosedLost()).toBe(false);
    expect(deposed).toEqual([]);
  });

  it('text naming this pid and start with another at deposes nothing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    takeWriterLock();
    const mine = JSON.parse(fs.readFileSync(writerLockPath(), 'utf8'));
    fs.writeFileSync(writerLockPath(), JSON.stringify({ ...mine, at: mine.at + 5 }));
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(deposed).toEqual([]);
  });

  it('a file naming another live process deposes the holder: shared writes refused, queued ones cancelled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    takeWriterLock();
    const queued = saveDataTracked('nb10deposed.json', { scope: 'global', category: 'nb10check' }, { v: 1 });
    expect(queued.outcome).toBe('saved');
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 4242, start: 'start-4242', role: 'bot', at: Date.now() }));
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed', holder: { pid: 4242 } });
    expect(deposed).toEqual([4242]);
    expect(sharedWritesClosedLost()).toBe(true);
    expect(saveDataTracked('nb10after.json', { scope: 'global', category: 'nb10check' }, { v: 2 })).toEqual({ outcome: 'refused', cause: 'writer-lost' });
    for (let i = 0; i < 50 && queuedFilePaths().some(p => p.includes('nb10check')); i++) await new Promise(r => setTimeout(r, 10));
    expect(queuedFilePaths().some(p => p.includes('nb10check'))).toBe(false);
    await new Promise(r => setTimeout(r, 50));
    expect(fs.existsSync(dataPath('global', 'nb10check', 'nb10deposed.json'))).toBe(false);
    expect(vi.mocked(console.error).mock.calls.some(c => String(c[0]) === `[Data] Not saved: ${dataPath('global', 'nb10check', 'nb10deposed.json')}; another process (a bot process, pid 4242) took the data files' lock`)).toBe(true);
    expect(fs.existsSync(dataPath('global', 'nb10check', 'nb10after.json'))).toBe(false);
    expect(writerLockDepth()).toBe(0);
    // The other holder releases: the next take reopens the shared writes.
    fs.unlinkSync(writerLockPath());
    expect(takeWriterLock().kind).toBe('taken');
    expect(sharedWritesClosedLost()).toBe(false);
  });

  it.each(['EMFILE', 'EIO'])('%s on the check\'s read leaves the holder writing with its queue intact, logged once', async code => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    takeWriterLock();
    const queued = saveDataTracked(`nb10${code}.json`, { scope: 'global', category: 'nb10check' }, { v: 1 });
    expect(queued.outcome).toBe('saved');
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p) === writerLockPath()) throw Object.assign(new Error(`${code}: refused`), { code });
      return (real as any)(p, ...rest);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    try {
      expect(checkWriterLock()).toEqual({ kind: 'held' });
      expect(checkWriterLock()).toEqual({ kind: 'held' });
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(errors.mock.calls.filter(c => String(c[0]).startsWith(`[Data] Cannot read ${writerLockPath()} (${code})`)).length).toBe(1);
    expect(sharedWritesClosedLost()).toBe(false);
    expect(deposed).toEqual([]);
    expect(saveDataTracked(`nb10${code}b.json`, { scope: 'global', category: 'nb10check' }, { v: 2 }).outcome).toBe('saved');
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath('global', 'nb10check', `nb10${code}.json`), 'utf8'))).toEqual({ v: 1 });
    expect(JSON.parse(fs.readFileSync(dataPath('global', 'nb10check', `nb10${code}b.json`), 'utf8'))).toEqual({ v: 2 });
  });

  it('a start reader that answers null leaves the holder holding at each check', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    while (writerLockDepth() > 0) releaseWriterLock();
    configureWriterLock('webui', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
    expect(takeWriterLock().kind).toBe('taken');
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(checkWriterLock()).toEqual({ kind: 'held' });
    expect(sharedWritesClosedLost()).toBe(false);
    expect(deposed).toEqual([]);
  });
});
