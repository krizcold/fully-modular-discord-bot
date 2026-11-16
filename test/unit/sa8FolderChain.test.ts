import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module reads the platform once at load: it loads here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

type Hold = { reached: () => void; released: Promise<void> };

const h = vi.hoisted(() => ({
  on: false,
  opens: 0,
  dirnames: 0,
  syncs: [] as string[],
  failOpen: new Map<string, string>(),
  failSync: new Map<string, string>(),
  holds: new Map<string, Hold>(),
  inodes: new Map<string, bigint>(),
  fds: new Map<number, string>(),
  nextFd: 900_000,
}));

const OPEN_BOUND = 200;
const DIRNAME_BOUND = 10_000;

vi.mock('path', async importOriginal => {
  const real = await importOriginal<any>();
  const dirname = (p: string) => {
    if (h.on && ++h.dirnames > DIRNAME_BOUND) throw new Error('path.dirname called past its bound: the walk does not end');
    return real.dirname(p);
  };
  return { ...real, dirname, default: { ...real, dirname } };
});

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const errno = (code: string, syscall: string) => Object.assign(new Error(`${code}: stubbed ${syscall}`), { code, syscall });
  const stats = (dir: string) => {
    if (!h.inodes.has(dir)) h.inodes.set(dir, BigInt(h.inodes.size + 1));
    return { dev: 1n, ino: h.inodes.get(dir)!, birthtimeNs: 5n };
  };
  const opened = (p: unknown) => {
    const dir = String(p);
    if (++h.opens > OPEN_BOUND) throw errno('EBOUND', 'open');
    const code = h.failOpen.get(dir);
    if (code) {
      h.failOpen.delete(dir);
      throw errno(code, 'open');
    }
    return dir;
  };
  const syncOf = (dir: string) => {
    h.syncs.push(dir);
    const code = h.failSync.get(dir);
    if (code) {
      h.failSync.delete(dir);
      throw errno(code, 'fsync');
    }
  };
  const open = async (p: any, flags?: any, ...rest: any[]) => {
    if (!h.on || flags !== 'r') return real.promises.open(p, flags, ...rest);
    const dir = opened(p);
    return {
      stat: async () => stats(dir),
      sync: async () => {
        const hold = h.holds.get(dir);
        if (hold) {
          h.holds.delete(dir);
          hold.reached();
          await hold.released;
        }
        syncOf(dir);
      },
      close: async () => undefined,
    };
  };
  const openSync = (p: any, flags?: any, ...rest: any[]) => {
    if (!h.on || flags !== 'r') return real.openSync(p, flags, ...rest);
    const dir = opened(p);
    const fd = h.nextFd++;
    h.fds.set(fd, dir);
    return fd;
  };
  const fstatSync = (fd: number, ...rest: any[]) => (h.fds.has(fd) ? stats(h.fds.get(fd)!) : real.fstatSync(fd, ...rest));
  const fsyncSync = (fd: number) => (h.fds.has(fd) ? syncOf(h.fds.get(fd)!) : real.fsyncSync(fd));
  const closeSync = (fd: number) => {
    if (h.fds.has(fd)) {
      h.fds.delete(fd);
      return undefined;
    }
    return real.closeSync(fd);
  };
  const promises = { ...real.promises, open };
  const over = { promises, openSync, fstatSync, fsyncSync, closeSync };
  return { ...real, ...over, default: { ...real, ...over } };
});

import fs from 'fs';
import {
  forgetDurableFolders,
  resetFolderSyncFailureForTests,
  syncFolder,
  syncFolderChain,
  syncFolderChainSync,
  syncFoldersUnder,
  type ChainAnswer,
} from '../../src/bot/internalSetup/utils/folderChain';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';

// NB19 decision 1: the folder chain from a folder up to DATA_ROOT, the skip of folders this process synced, the folders
// under a root, and the flag a folder sync error sets, each as the device sees it (which folders are synced, in order)
// and as the caller is answered.

const ROOT = path.resolve(DATA_ROOT);
let n = 0;
const fresh = () => `sa8-${process.pid}-${++n}`;

function hold(dir: string): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  h.holds.set(path.resolve(dir), { reached, released });
  return { reached: reachedP, release };
}

async function within<T>(p: Promise<T>, what: string, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen in ${ms} ms`)), ms); });
  try {
    return await Promise.race([p, bound]);
  } finally {
    clearTimeout(timer);
  }
}

const earlierAt = (dir: string): ChainAnswer => ({ failed: true, kind: 'earlier', dir, errno: 'EIO', error: null });

async function setFlagThrough(dir: string): Promise<void> {
  h.failSync.set(dir, 'EIO');
  expect(await syncFolder(dir)).toMatchObject({ failed: true, kind: 'sync', dir, errno: 'EIO' });
}

beforeEach(() => {
  resetFolderSyncFailureForTests();
  forgetDurableFolders();
  h.on = true;
  h.opens = 0;
  h.dirnames = 0;
  h.syncs.length = 0;
  h.failOpen.clear();
  h.failSync.clear();
  h.holds.clear();
  h.fds.clear();
});
afterEach(() => {
  h.on = false;
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

describe('the folder chain up to DATA_ROOT, on Linux', () => {
  it('a walk from a folder under DATA_ROOT syncs it and each folder above it, and stops at DATA_ROOT', async () => {
    const top = fresh();
    await expect(syncFolderChain(dataPath(top, 'a', 'b'))).resolves.toEqual({ failed: false });
    expect(h.syncs).toEqual([dataPath(top, 'a', 'b'), dataPath(top, 'a'), dataPath(top), ROOT]);
  });

  it('a second walk from the same folder syncs only that folder, whose entry the first walk synced', async () => {
    const top = fresh();
    const dir = dataPath(top, 'a', 'b');
    await expect(syncFolderChain(dir)).resolves.toEqual({ failed: false });
    h.syncs.length = 0;
    await expect(syncFolderChain(dir)).resolves.toEqual({ failed: false });
    expect(h.syncs).toEqual([dir]);
    h.syncs.length = 0;
    await expect(syncFolderChain(dataPath(top, 'a', 'c'))).resolves.toEqual({ failed: false });
    expect(h.syncs).toEqual([dataPath(top, 'a', 'c'), dataPath(top, 'a')]);
  });

  it('a walk from a folder beside DATA_ROOT syncs that folder only', async () => {
    const beside = path.join(path.dirname(ROOT), `${fresh()}-beside`);
    await expect(syncFolderChain(beside)).resolves.toEqual({ failed: false });
    expect(h.syncs).toEqual([beside]);
  });

  it('records forgotten while a walk runs are not taken from that walk: the next walk syncs the whole chain', async () => {
    const top = fresh();
    const dir = dataPath(top, 'a', 'b');
    const held = hold(ROOT);
    const walk = syncFolderChain(dir);
    await within(held.reached, 'the sync of DATA_ROOT');
    forgetDurableFolders();
    held.release();
    await expect(within(walk, 'the first walk')).resolves.toEqual({ failed: false });
    h.syncs.length = 0;
    await expect(syncFolderChain(dir)).resolves.toEqual({ failed: false });
    expect(h.syncs).toEqual([dir, dataPath(top, 'a'), dataPath(top), ROOT]);
  });

  it('a folder sync error elsewhere while the walk syncs its last folder answers earlier, and records nothing', async () => {
    const top = fresh();
    const dir = dataPath(top, 'a');
    const other = dataPath(fresh());
    const held = hold(ROOT);
    const walk = syncFolderChain(dir);
    await within(held.reached, 'the sync of DATA_ROOT');
    await setFlagThrough(other);
    held.release();
    await expect(within(walk, 'the walk')).resolves.toEqual(earlierAt(other));
    expect(h.syncs).toEqual([dir, dataPath(top), other, ROOT]);
  });

  it('a folder sync error elsewhere while the walk syncs its first folder stops the walk before the next folder', async () => {
    const top = fresh();
    const dir = dataPath(top, 'a');
    const other = dataPath(fresh());
    const held = hold(dir);
    const walk = syncFolderChain(dir);
    await within(held.reached, 'the sync of the first folder');
    await setFlagThrough(other);
    held.release();
    await expect(within(walk, 'the walk')).resolves.toEqual(earlierAt(other));
    expect(h.syncs).toEqual([other, dir]);
  });

  it('the synchronous walk syncs each folder up to DATA_ROOT, and a second walk only the folder it starts at', () => {
    const top = fresh();
    const dir = dataPath(top, 'a', 'b');
    expect(syncFolderChainSync(dir)).toEqual({ failed: false });
    expect(h.syncs).toEqual([dir, dataPath(top, 'a'), dataPath(top), ROOT]);
    h.syncs.length = 0;
    expect(syncFolderChainSync(dir)).toEqual({ failed: false });
    expect(h.syncs).toEqual([dir]);
  });
});

describe('every folder under a root, on Linux', () => {
  function tree(): string {
    const root = dataPath(fresh());
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'f.json'), '{}');
    fs.writeFileSync(path.join(root, 'a', 'g.json'), '{}');
    return root;
  }

  it('syncs each folder after the folders below it, then the root, and no file', async () => {
    const root = tree();
    await expect(syncFoldersUnder(root)).resolves.toEqual({ failed: false });
    expect(h.syncs).toEqual([path.join(root, 'a', 'b'), path.join(root, 'a'), root]);
  });

  it('a folder that cannot be opened is answered, and no folder after it is synced', async () => {
    const root = tree();
    const a = path.join(root, 'a');
    h.failOpen.set(a, 'EMFILE');
    await expect(syncFoldersUnder(root)).resolves.toMatchObject({ failed: true, kind: 'open', dir: a, errno: 'EMFILE' });
    expect(h.syncs).toEqual([path.join(root, 'a', 'b')]);
  });

  it('after a folder sync error it answers earlier without reading the root, even one that is not there', async () => {
    const other = dataPath(fresh());
    await setFlagThrough(other);
    h.syncs.length = 0;
    await expect(syncFoldersUnder(dataPath(fresh(), 'missing'))).resolves.toEqual(earlierAt(other));
    expect(h.syncs).toEqual([]);
  });

  it('a folder sync error elsewhere while it syncs a folder stops it before the next folder', async () => {
    const root = dataPath(fresh());
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    const other = dataPath(fresh());
    const held = hold(path.join(root, 'a'));
    const run = syncFoldersUnder(root);
    await within(held.reached, 'the sync of the folder below the root');
    await setFlagThrough(other);
    held.release();
    await expect(within(run, 'the run')).resolves.toEqual(earlierAt(other));
    expect(h.syncs).toEqual([other, path.join(root, 'a')]);
  });
});
