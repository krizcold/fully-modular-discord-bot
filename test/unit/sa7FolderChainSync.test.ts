import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module reads the platform once at load: it loads here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

type Id = { dev: bigint; ino: bigint; birthtimeNs: bigint };
const h = vi.hoisted(() => ({
  on: false,
  next: 1_000_000,
  fds: new Map<number, string>(),
  opens: [] as string[],
  syncs: [] as string[],
  closes: [] as string[],
  openErr: new Map<string, string>(),
  statErr: new Map<string, string>(),
  syncErr: new Map<string, string>(),
  closeErr: new Map<string, string>(),
  inos: new Map<string, bigint>(),
  idOver: new Map<string, Partial<Id>>(),
  birth: 5n,
}));

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const fault = (code: string) => Object.assign(new Error(`${code}: fault`), { code });
  const identity = (p: string): Id => {
    if (!h.inos.has(p)) h.inos.set(p, BigInt(h.inos.size + 10));
    return { dev: 1n, ino: h.inos.get(p)!, birthtimeNs: h.birth, ...h.idOver.get(p) };
  };
  const open = (file: unknown): number => {
    const p = path.resolve(String(file));
    h.opens.push(p);
    if (h.opens.length > 200) throw fault('ELOOPGUARD');
    const code = h.openErr.get(p);
    if (code) throw fault(code);
    const fd = h.next++;
    h.fds.set(fd, p);
    return fd;
  };
  const stat = (fd: number) => {
    const p = h.fds.get(fd)!;
    const code = h.statErr.get(p);
    if (code) throw fault(code);
    return identity(p);
  };
  const sync = (fd: number) => {
    const p = h.fds.get(fd)!;
    h.syncs.push(p);
    const code = h.syncErr.get(p);
    if (code) throw fault(code);
  };
  const close = (fd: number) => {
    const p = h.fds.get(fd)!;
    h.closes.push(p);
    h.fds.delete(fd);
    const code = h.closeErr.get(p);
    if (code) throw fault(code);
  };
  const over = {
    openSync: (file: any, flags?: any, ...rest: any[]) => (h.on && flags === 'r' ? open(file) : real.openSync(file, flags, ...rest)),
    fstatSync: (fd: any, ...rest: any[]) => (h.fds.has(fd) ? stat(fd) : real.fstatSync(fd, ...rest)),
    fsyncSync: (fd: any) => (h.fds.has(fd) ? sync(fd) : real.fsyncSync(fd)),
    closeSync: (fd: any) => (h.fds.has(fd) ? close(fd) : real.closeSync(fd)),
    promises: {
      ...real.promises,
      open: async (file: any, flags?: any, ...rest: any[]) => {
        if (!(h.on && flags === 'r')) return real.promises.open(file, flags, ...rest);
        const fd = open(file);
        return { stat: async () => stat(fd), sync: async () => sync(fd), close: async () => close(fd) };
      },
    },
  };
  return { ...real, ...over, default: { ...real, ...over } };
});

import {
  flagAnswer,
  folderSyncFailed,
  forgetDurableFolders,
  noteFolderSyncFailure,
  resetFolderSyncFailureForTests,
  syncFolder,
  syncFolderChainSync,
  syncFolderSync,
} from '../../src/bot/internalSetup/utils/folderChain';
import { DATA_ROOT } from '../../src/utils/dataRoot';

// folderChain.ts (NB19 decision 1): one folder is opened read-only, fsynced and closed; the chain walks up to DATA_ROOT
// and stops after a folder whose entry this process synced, judged by its device, inode and birth time.

const ROOT = path.resolve(DATA_ROOT);
let n = 0;
let errors: string[];
let G: string;
let M: string;

beforeEach(() => {
  resetFolderSyncFailureForTests();
  forgetDurableFolders();
  h.fds.clear();
  for (const list of [h.opens, h.syncs, h.closes]) list.length = 0;
  for (const map of [h.openErr, h.statErr, h.syncErr, h.closeErr, h.inos, h.idOver]) map.clear();
  h.birth = 5n;
  h.on = true;
  G = path.join(ROOT, `sa7-${process.pid}-${++n}`);
  M = path.join(G, 'm');
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});
afterEach(() => {
  h.on = false;
  vi.restoreAllMocks();
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

const closeLine = (dir: string, code: string) =>
  `[Data] ${dir}: the directory could not be closed after its sync (${code}); this changes nothing about the lines already reported for the files in it`;

describe('syncFolderSync: one folder', () => {
  it('opens the folder, fsyncs it once, closes it once and answers ok', () => {
    expect(syncFolderSync(M)).toEqual({ failed: false });
    expect(h.opens).toEqual([M]);
    expect(h.syncs).toEqual([M]);
    expect(h.closes).toEqual([M]);
    expect(h.fds.size).toBe(0);
    expect(folderSyncFailed()).toBe(false);
  });

  for (const code of ['EPERM', 'EACCES', 'EISDIR']) {
    it(`a folder whose open answers ${code} is passed over: ok, nothing synced, the flag clear`, () => {
      h.openErr.set(M, code);
      expect(syncFolderSync(M)).toEqual({ failed: false });
      expect(h.syncs).toEqual([]);
      expect(folderSyncFailed()).toBe(false);
    });
  }

  it('an open that answers EMFILE gives an open failure naming the folder; the flag stays clear', () => {
    h.openErr.set(M, 'EMFILE');
    expect(syncFolderSync(M)).toMatchObject({ failed: true, kind: 'open', dir: M, errno: 'EMFILE' });
    expect(folderSyncFailed()).toBe(false);
  });

  it('an fsync that answers EIO gives a sync failure, sets the flag, and the folder is still closed', () => {
    h.syncErr.set(M, 'EIO');
    expect(syncFolderSync(M)).toMatchObject({ failed: true, kind: 'sync', dir: M, errno: 'EIO' });
    expect(folderSyncFailed()).toBe(true);
    expect(h.closes).toEqual([M]);
    expect(h.fds.size).toBe(0);
  });

  it('a stat of the handle that answers EIO gives a sync failure and sets the flag; the folder is not fsynced', () => {
    h.statErr.set(M, 'EIO');
    expect(syncFolderSync(M)).toMatchObject({ failed: true, kind: 'sync', dir: M, errno: 'EIO' });
    expect(folderSyncFailed()).toBe(true);
    expect(h.syncs).toEqual([]);
    expect(h.closes).toEqual([M]);
  });

  it('after a stat that answers ENOMEM, the answer is the open failure and an fsync error never replaces it', () => {
    h.statErr.set(M, 'ENOMEM');
    h.syncErr.set(M, 'EIO');
    expect(syncFolderSync(M)).toMatchObject({ failed: true, kind: 'open', dir: M, errno: 'ENOMEM' });
    expect(folderSyncFailed()).toBe(false);
    expect(h.syncs).toEqual([]);
  });

  it('a close that answers EBADF is logged with its code, and the answer stays ok', () => {
    h.closeErr.set(M, 'EBADF');
    expect(syncFolderSync(M)).toEqual({ failed: false });
    expect(h.closes).toEqual([M]);
    expect(errors).toEqual([closeLine(M, 'EBADF')]);
  });

  it('after a folder sync error, it opens no folder and answers earlier with the first error', () => {
    noteFolderSyncFailure(ROOT, 'EIO');
    h.openErr.set(M, 'EMFILE');
    expect(syncFolderSync(M)).toEqual({ failed: true, kind: 'earlier', dir: ROOT, errno: 'EIO', error: null });
    expect(h.opens).toEqual([]);
  });

  it('syncFolder: after a folder sync error, it opens no folder and answers earlier with the first error', async () => {
    noteFolderSyncFailure(ROOT, 'EIO');
    h.openErr.set(M, 'EMFILE');
    expect(await syncFolder(M)).toEqual({ failed: true, kind: 'earlier', dir: ROOT, errno: 'EIO', error: null });
    expect(h.opens).toEqual([]);
  });

  it('flagAnswer is ok while the flag is clear and earlier once a folder sync error set it', () => {
    expect(flagAnswer()).toEqual({ failed: false });
    noteFolderSyncFailure(G, 'ENOSPC');
    expect(flagAnswer()).toEqual({ failed: true, kind: 'earlier', dir: G, errno: 'ENOSPC', error: null });
  });
});

describe('syncFolderChainSync: the chain and its skip', () => {
  it('the first chain from G/m syncs G/m, G and the data root, and goes no higher', () => {
    expect(syncFolderChainSync(M)).toEqual({ failed: false });
    expect(h.syncs).toEqual([M, G, ROOT]);
    expect(h.fds.size).toBe(0);
  });

  it('a chain that starts at the data root syncs the data root only', () => {
    expect(syncFolderChainSync(ROOT)).toEqual({ failed: false });
    expect(h.syncs).toEqual([ROOT]);
  });

  it('a second chain from G/m syncs G/m only, since its entry in G was synced', () => {
    syncFolderChainSync(M);
    h.syncs.length = 0;
    expect(syncFolderChainSync(M)).toEqual({ failed: false });
    expect(h.syncs).toEqual([M]);
  });

  it('a folder with birth time 0 is never taken as recorded: every chain walks to the data root', () => {
    h.birth = 0n;
    expect(syncFolderChainSync(M)).toEqual({ failed: false });
    expect(h.syncs).toEqual([M, G, ROOT]);
    h.syncs.length = 0;
    expect(syncFolderChainSync(M)).toEqual({ failed: false });
    expect(h.syncs).toEqual([M, G, ROOT]);
  });

  for (const field of ['dev', 'ino', 'birthtimeNs'] as const) {
    it(`G/m replaced by a folder with another ${field} is synced again with its parent G`, () => {
      syncFolderChainSync(M);
      h.syncs.length = 0;
      h.idOver.set(M, { [field]: 999n });
      expect(syncFolderChainSync(M)).toEqual({ failed: false });
      expect(h.syncs).toEqual([M, G]);
    });
  }
});
