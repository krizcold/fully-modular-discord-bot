import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 round 3 fixes: a whole write renamed into place whose chain failed while a newer write of the path stays
// queued answers 'unavailable', never 'held' (DL-1); the staged module tree's and the fetched module's folder syncs go
// through folderChain, so their error sets the flag (DL-2).

const h = vi.hoisted(() => ({
  chain: null as null | { dir: string; before: () => void; answer: { failed: true; kind: 'open'; dir: string; errno: string; error: null } },
  failTemp: null as null | string,
  fdDir: new Map<number, string>(),
  failSync: new Map<string, string>(),
  shared: false,
  reads: 0,
}));

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const norm = (p: unknown) => path.resolve(String(p));
  const openSync = (file: any, flags?: any, ...rest: any[]) => {
    const fd = real.openSync(file, flags, ...rest);
    let dir = false;
    try { dir = (flags === 'r' || flags === undefined) && real.statSync(String(file)).isDirectory(); } catch { /* not there */ }
    if (dir) h.fdDir.set(fd, norm(file));
    return fd;
  };
  const fsyncSync = (fd: number) => {
    const dir = h.fdDir.get(fd);
    const code = dir === undefined ? undefined : h.failSync.get(dir);
    if (dir !== undefined && code) {
      h.failSync.delete(dir);
      throw Object.assign(new Error(`${code}: i/o error, fsync`), { code });
    }
    return real.fsyncSync(fd);
  };
  const closeSync = (fd: number) => { h.fdDir.delete(fd); return real.closeSync(fd); };
  const over = { openSync, fsyncSync, closeSync };
  return { ...real, ...over, default: { ...real, ...over } };
});

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      const s = h.chain;
      if (s && path.resolve(dir) === s.dir) {
        h.chain = null;
        s.before();
        return s.answer;
      }
      return real.syncFolderChain(dir);
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    rowBackend: () => (h.shared ? { sharedRead: async () => { h.reads++; return { kind: 'read', rows: [] }; } } : real.rowBackend()),
  };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

import fs from 'fs';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import {
  confirmFile,
  enqueueWrite,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { FolderSyncError, folderSyncFailed, resetFolderSyncFailureForTests, syncStepError, syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { atomicWriteFileSync } from '../../src/bot/internalSetup/utils/atomicWrite';
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { fetchModule } from '../../src/bot/internalSetup/utils/sharedModules';

const POSIX = process.platform !== 'win32';
const ROOT = path.resolve(DATA_ROOT);
let n = 0;
let errors: string[];
const guild = () => `7${Date.now() % 1_000_000}${++n}`;
const fresh = () => path.join(ROOT, `nb19-fix3-${process.pid}-${Date.now()}-${++n}`);
const T2 = (p: string, kind: 'sync' | 'open' | 'earlier', dir: string, errno: string) => {
  const { why, next } = syncWords(kind, dir, errno);
  return `[Data] ${p}: the file is written whole, but ${why}; it is not written again; can't confirm it is stored. ${next}`;
};

beforeEach(() => {
  h.chain = null;
  h.failTemp = null;
  h.failSync.clear();
  h.shared = false;
  resetFolderSyncFailureForTests();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const realOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
    const p = String(file);
    if (flags === 'w' && h.failTemp && p.startsWith(`${h.failTemp}.`) && p.endsWith('.tmp')) {
      throw Object.assign(new Error('EMFILE: too many open files, open'), { code: 'EMFILE' });
    }
    return realOpen(file, flags, mode);
  }) as typeof fs.promises.open);
});
afterEach(async () => {
  h.failTemp = null;
  h.chain = null;
  await flushAll();
  vi.restoreAllMocks();
  resetFolderSyncFailureForTests();
});

describe('DL-1: a renamed whole write whose chain failed, with a newer write still queued', () => {
  it('answers unavailable with kind open and logs T2, never held, while the newer write fails before its rename', async () => {
    const p = dataPath(guild(), 'm', 'x.json');
    const dir = path.dirname(p);
    h.chain = {
      dir,
      before: () => {
        enqueueWrite(p, '{"v":2}');
        h.failTemp = p;
      },
      answer: { failed: true, kind: 'open', dir, errno: 'EMFILE', error: null },
    };
    enqueueWrite(p, '{"v":1}');
    const t1 = fileTicket(p);
    const answer = await confirmFile(t1, 5000);
    expect(answer).toBe('unavailable');
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(fileTicketFailure(t1)).toMatchObject({ what: 'whole', kind: 'open', dir, errno: 'EMFILE' });
    expect(errors).toContain(T2(p, 'open', dir, 'EMFILE'));
    expect(fs.readFileSync(p, 'utf8')).toBe('{"v":1}');
  });

  it('a ticket of the newer write itself still answers held while it fails before its rename', async () => {
    const p = dataPath(guild(), 'm', 'y.json');
    const dir = path.dirname(p);
    let t2: ReturnType<typeof fileTicket> | null = null;
    h.chain = {
      dir,
      before: () => {
        enqueueWrite(p, '{"v":2}');
        t2 = fileTicket(p);
        h.failTemp = p;
      },
      answer: { failed: true, kind: 'open', dir, errno: 'EMFILE', error: null },
    };
    enqueueWrite(p, '{"v":1}');
    await flushAll();
    expect(t2).not.toBeNull();
    expect(await confirmFile(t2!, 5000)).toBe('held');
    expect(fs.readFileSync(p, 'utf8')).toBe('{"v":1}');
  });
});

describe('DL-2: the staged module tree and the fetched module folder sync through folderChain', () => {
  it('syncStepError carries the sync clause, its next step and the errno', () => {
    const error = syncStepError({ failed: true, kind: 'sync', dir: '/data/x', errno: 'EIO', error: null });
    expect(error).not.toBeInstanceOf(FolderSyncError);
    expect(error.message).toBe(`${syncWords('sync', '/data/x', 'EIO').why}. Check the disk, then restart the machine.`);
    expect(error).toMatchObject({ code: 'EIO', kind: 'sync', dir: '/data/x' });
  });

  it.skipIf(!POSIX)('an EIO on a staged folder fails the publish and sets the flag; a later save throws FolderSyncError of kind earlier', async () => {
    const staged = fresh();
    fs.mkdirSync(path.join(staged, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'sub', 'a.ts'), 'export {};');
    h.failSync.set(path.join(staged, 'sub'), 'EIO');
    const publishStaged = (AppStoreManager.prototype as any).publishStaged as (...a: unknown[]) => Promise<unknown>;
    await expect(publishStaged.call({}, 'install', 'alpha', { dir: staged, version: '1.0.0', body: '{}', base: null }))
      .rejects.toMatchObject({ code: 'EIO', message: `${syncWords('sync', path.join(staged, 'sub'), 'EIO').why}. Check the disk, then restart the machine.` });
    expect(fs.existsSync(staged)).toBe(false);
    expect(folderSyncFailed()).toBe(true);
    const other = path.join(fresh(), 'b.json');
    let error: unknown;
    try { atomicWriteFileSync(other, '{}'); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(FolderSyncError);
    expect(error).toMatchObject({ kind: 'earlier', dir: path.join(staged, 'sub'), code: 'EIO' });
  });

  it.skipIf(!POSIX)('an EIO on the fetched module folder fails the fetch and sets the flag; under it the next fetch answers earlier and reads nothing', async () => {
    h.shared = true;
    const into = fresh();
    h.failSync.set(path.resolve(into), 'EIO');
    const first = await fetchModule('alpha', into);
    expect(first).toEqual({ ok: false, cause: syncWords('sync', path.resolve(into), 'EIO').why, restart: true });
    expect(folderSyncFailed()).toBe(true);
    h.reads = 0;
    const later = fresh();
    const second = await fetchModule('alpha', later);
    expect(second).toEqual({ ok: false, cause: syncWords('earlier', path.resolve(into), 'EIO').why, restart: true });
    expect(h.reads).toBe(0);
    expect(fs.existsSync(later)).toBe(false);
  });

  it.skipIf(POSIX)('on Windows the staged tree and the fetch open no folder and answer as before', async () => {
    h.shared = true;
    const into = fresh();
    expect(await fetchModule('alpha', into)).toMatchObject({ ok: true, files: 0 });
    expect(folderSyncFailed()).toBe(false);
  });
});
