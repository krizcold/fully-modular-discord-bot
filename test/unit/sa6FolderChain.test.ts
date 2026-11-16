import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module reads the platform once at load: it loads here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import {
  folderSyncFailed,
  forgetDurableFolders,
  noteFolderSyncFailure,
  syncFolder,
  syncFolderChain,
  syncFolderSync,
} from '../../src/bot/internalSetup/utils/folderChain';
import { DATA_ROOT } from '../../src/utils/dataRoot';

const ROOT = path.resolve(DATA_ROOT);
const realOpen = fs.promises.open.bind(fs.promises);
const errno = (code: unknown) => Object.assign(new Error(`stubbed ${String(code)}`), { code });
const noCode = () => new Error('stubbed, no code');

type Plan = { open?: unknown; stat?: unknown; sync?: unknown; close?: unknown };
let plans: Map<string, Plan>;
let opened: string[];
let closed: string[];
let synced: string[];
let errors: string[];
const inodes = new Map<string, bigint>();
let n = 0;

const at = (...parts: string[]) => path.join(ROOT, ...parts);
const plan = (dir: string, p: Plan) => plans.set(path.resolve(dir), p);

function fakeFolders(): void {
  vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike) => {
    const p = path.resolve(String(file));
    const steps = plans.get(p) ?? {};
    if ('open' in steps) throw steps.open;
    opened.push(p);
    if (!inodes.has(p)) inodes.set(p, BigInt(inodes.size + 100));
    return {
      stat: async () => {
        if ('stat' in steps) throw steps.stat;
        return { dev: 1n, ino: inodes.get(p)!, birthtimeNs: 5n };
      },
      sync: async () => {
        synced.push(p);
        if ('sync' in steps) throw steps.sync;
      },
      close: async () => {
        closed.push(p);
        if ('close' in steps) throw steps.close;
      },
    };
  }) as any);
}

beforeEach(() => {
  plans = new Map();
  opened = [];
  closed = [];
  synced = [];
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

describe('a folder whose open fails', () => {
  it('answers an open failure with its errno and sets no flag when the open fails with EMFILE', async () => {
    fakeFolders();
    const dir = at(`sa6-${++n}`);
    plan(dir, { open: errno('EMFILE') });
    expect(await syncFolder(dir)).toMatchObject({ failed: true, kind: 'open', dir, errno: 'EMFILE' });
    expect(folderSyncFailed()).toBe(false);
  });

  it('answers EIO at the open as the disk\'s answer: a sync failure that sets the flag', async () => {
    fakeFolders();
    const dir = at(`sa6-${++n}`);
    plan(dir, { open: errno('EIO') });
    expect(await syncFolder(dir)).toMatchObject({ failed: true, kind: 'sync', dir, errno: 'EIO' });
    expect(folderSyncFailed()).toBe(true);
    expect(await syncFolder(at(`sa6-${++n}`))).toMatchObject({ failed: true, kind: 'earlier', dir, errno: 'EIO' });
  });

  it('takes an open error that carries no code as EIO', async () => {
    fakeFolders();
    const dir = at(`sa6-${++n}`);
    plan(dir, { open: noCode() });
    expect(await syncFolder(dir)).toMatchObject({ failed: true, kind: 'sync', dir, errno: 'EIO' });
    expect(folderSyncFailed()).toBe(true);
  });

  for (const code of ['EISDIR', 'EPERM', 'EACCES']) {
    it(`passes over a folder whose open fails with ${code}`, async () => {
      fakeFolders();
      const dir = at(`sa6-${++n}`);
      plan(dir, { open: errno(code) });
      expect(await syncFolder(dir)).toEqual({ failed: false });
      expect(folderSyncFailed()).toBe(false);
    });
  }
});

describe('a folder whose stat or sync fails', () => {
  it('answers EIO at the stat as a sync failure that sets the flag, and closes the folder', async () => {
    fakeFolders();
    const dir = at(`sa6-${++n}`);
    plan(dir, { stat: errno('EIO') });
    expect(await syncFolder(dir)).toMatchObject({ failed: true, kind: 'sync', dir, errno: 'EIO' });
    expect(folderSyncFailed()).toBe(true);
    expect(closed).toEqual([dir]);
  });

  it('does not sync after a failed stat, so a sync error that is passed over cannot hide the stat failure', async () => {
    fakeFolders();
    const dir = at(`sa6-${++n}`);
    plan(dir, { stat: errno('EMFILE'), sync: errno('EINVAL') });
    expect(await syncFolder(dir)).toMatchObject({ failed: true, kind: 'open', dir, errno: 'EMFILE' });
    expect(synced).toEqual([]);
    expect(closed).toEqual([dir]);
  });

  for (const code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']) {
    it(`passes over a folder sync that fails with ${code}`, async () => {
      fakeFolders();
      const dir = at(`sa6-${++n}`);
      plan(dir, { sync: errno(code) });
      expect(await syncFolder(dir)).toEqual({ failed: false });
      expect(folderSyncFailed()).toBe(false);
    });
  }

  it('sets the flag at a sync EIO, so the next folder sync answers earlier', async () => {
    fakeFolders();
    const dir = at(`sa6-${++n}`);
    plan(dir, { sync: errno('EIO') });
    expect(await syncFolder(dir)).toMatchObject({ failed: true, kind: 'sync', dir, errno: 'EIO' });
    expect(folderSyncFailed()).toBe(true);
    expect(await syncFolder(at(`sa6-${++n}`))).toMatchObject({ failed: true, kind: 'earlier', dir, errno: 'EIO' });
  });

  it('keeps the first folder sync error as the flag', async () => {
    noteFolderSyncFailure('/first', 'EIO');
    noteFolderSyncFailure('/second', 'EROFS');
    expect(await syncFolder(at(`sa6-${++n}`))).toEqual({ failed: true, kind: 'earlier', dir: '/first', errno: 'EIO', error: null });
  });
});

describe('closing the folder', () => {
  it('closes the folder after a sync that worked and after one that failed', async () => {
    fakeFolders();
    const ok = at(`sa6-${++n}`);
    expect(await syncFolder(ok)).toEqual({ failed: false });
    expect(closed).toEqual([ok]);
    const bad = at(`sa6-${++n}`);
    plan(bad, { sync: errno('EMFILE') });
    expect((await syncFolder(bad)).failed).toBe(true);
    expect(closed).toEqual([ok, bad]);
  });

  const line = (dir: string, code: string) =>
    `[Data] ${dir}: the directory could not be closed after its sync (${code}); this changes nothing about the lines already reported for the files in it`;

  for (const [label, thrown, code] of [
    ['an errno', errno('EBADF'), 'EBADF'],
    ['an error with no code', noCode(), 'no error code'],
    ['an error whose code is null', errno(null), 'no error code'],
    ['null', null, 'no error code'],
  ] as const) {
    it(`logs a close that fails with ${label} and still answers the sync`, async () => {
      fakeFolders();
      const dir = at(`sa6-${++n}`);
      plan(dir, { close: thrown });
      expect(await syncFolder(dir)).toEqual({ failed: false });
      expect(errors).toEqual([line(dir, code)]);
    });
  }
});

describe('the records of synced folders', () => {
  it('a chain stops at a recorded folder, and forgetting a folder forgets it and the folders below it only', async () => {
    fakeFolders();
    const base = at(`sa6-${++n}`);
    const b = path.join(base, 'b');
    const c = path.join(b, 'c');
    expect(await syncFolderChain(b)).toEqual({ failed: false });
    expect(opened).toEqual([b, base, ROOT]);
    opened = [];
    expect(await syncFolderChain(c)).toEqual({ failed: false });
    expect(opened).toEqual([c, b]);
    forgetDurableFolders(b);
    opened = [];
    expect(await syncFolderChain(c)).toEqual({ failed: false });
    expect(opened).toEqual([c, b, base]);
  });
});

describe('a real folder opened read-only', () => {
  it('syncFolder opens a real folder and answers that it synced', async () => {
    const dir = at(`sa6-real-${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike, flags?: any) => {
      const h = await realOpen(file, flags);
      return { stat: (o: any) => h.stat(o), sync: async () => undefined, close: () => h.close() };
    }) as any);
    expect(await syncFolder(dir)).toEqual({ failed: false });
  });

  it('syncFolderSync opens a real folder and answers that it synced', () => {
    const dir = at(`sa6-real-${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => undefined);
    expect(syncFolderSync(dir)).toEqual({ failed: false });
  });
});
