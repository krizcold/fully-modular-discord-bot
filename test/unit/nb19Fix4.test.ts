import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 round 4 fixes: confirmFile answers 'unavailable' for a ticket a replaced try covers at every answer, so the
// deadline-0 re-read never gives 'held' (DL-1); a fetch under the flag reads nothing and its text asks for the restart
// (O1); syncStepError carries the kind's next step (O2).

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
import { confirmWrite } from '../../src/bot/internalSetup/utils/dataManager';
import { noteFolderSyncFailure, resetFolderSyncFailureForTests, syncStepError, syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { fetchModule } from '../../src/bot/internalSetup/utils/sharedModules';
import { deferredText } from '../../src/bot/internalSetup/utils/moduleApply';

const POSIX = process.platform !== 'win32';
const ROOT = path.resolve(DATA_ROOT);
let n = 0;
let errors: string[];
const guild = () => `8${Date.now() % 1_000_000}${++n}`;
const fresh = () => path.join(ROOT, `nb19-fix4-${process.pid}-${Date.now()}-${++n}`);
const T2 = (p: string, kind: 'sync' | 'open' | 'earlier', dir: string, errno: string) => {
  const { why, next } = syncWords(kind, dir, errno);
  return `[Data] ${p}: the file is written whole, but ${why}; it is not written again; can't confirm it is stored. ${next}`;
};

beforeEach(() => {
  h.chain = null;
  h.failTemp = null;
  h.failSync.clear();
  h.shared = false;
  h.reads = 0;
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

/** W1 renamed into place, its chain answered 'open' while W2 was enqueued, and W2 failing at its temp open. */
async function replacedWithNewerQueued(name: string) {
  const p = dataPath(guild(), 'm', name);
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
  await flushAll();
  return { p, dir, t1 };
}

describe('DL-1: the deadline-0 re-read of a renamed whole write whose chain failed', () => {
  it('confirmFile(ticket, 0) answers unavailable, not pending, and fails the replaced try once', async () => {
    const { p, dir, t1 } = await replacedWithNewerQueued('x.json');
    expect(fileTicketState(t1)).not.toBe('unconfirmed');
    expect(await confirmFile(t1, 0)).toBe('unavailable');
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(fileTicketFailure(t1)).toMatchObject({ what: 'whole', kind: 'open', dir, errno: 'EMFILE' });
    expect(errors.filter(e => e === T2(p, 'open', dir, 'EMFILE'))).toHaveLength(1);
    expect(fs.readFileSync(p, 'utf8')).toBe('{"v":1}');
  });

  it('confirmWrite(ticket, 0), the reply gate and confirmSaved re-read, answers unavailable', async () => {
    const { t1 } = await replacedWithNewerQueued('y.json');
    expect(await confirmWrite(t1, 0)).toBe('unavailable');
  });

  it('a ticket of the newer write, which no replaced try covers, still answers pending at deadline 0', async () => {
    const p = dataPath(guild(), 'm', 'z.json');
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
    expect(await confirmFile(t2!, 0)).toBe('pending');
  });
});

describe('O1: a fetch under the flag', () => {
  it.skipIf(!POSIX)('answers restart with the earlier clause and reads nothing from the database', async () => {
    h.shared = true;
    noteFolderSyncFailure('/data/g', 'EIO');
    const into = fresh();
    expect(await fetchModule('alpha', into)).toEqual({ ok: false, cause: syncWords('earlier', '/data/g', 'EIO').why, restart: true });
    expect(h.reads).toBe(0);
    expect(fs.existsSync(into)).toBe(false);
  });

  it.skipIf(!POSIX)('an EIO on the fetched folder answers restart with the sync clause', async () => {
    h.shared = true;
    const into = fresh();
    h.failSync.set(path.resolve(into), 'EIO');
    expect(await fetchModule('alpha', into)).toEqual({ ok: false, cause: syncWords('sync', path.resolve(into), 'EIO').why, restart: true });
  });

  it('the deferred text asks for the restart and promises no next pass', () => {
    const why = syncWords('earlier', '/data/g', 'EIO').why;
    const text = deferredText('update', 'alpha', '1.2.0', { outcome: 'deferred', reason: 'fetch', error: why, loaded: false, restart: true });
    expect(text).toBe(`alpha 1.2.0 was updated. This machine can't apply it until the machine is restarted (${why}). Check the disk, then restart the machine.`);
    expect(text).not.toContain('next pass');
  });

  it('a fetch that failed for another cause keeps the next-pass text', () => {
    expect(deferredText('install', 'alpha', '1.2.0', { outcome: 'deferred', reason: 'fetch', error: 'the database did not answer', loaded: false }))
      .toBe('alpha 1.2.0 was installed. This machine applies it at its next pass (the database did not answer).');
  });
});

describe('O2: syncStepError carries the next step', () => {
  for (const kind of ['sync', 'earlier', 'open'] as const) {
    it(`kind ${kind}: the clause, then the step's next step, with the errno, kind and folder`, () => {
      const error = syncStepError({ failed: true, kind, dir: '/data/x', errno: 'EIO', error: null });
      const { why } = syncWords(kind, '/data/x', 'EIO');
      expect(error.message).toBe(`${why}. ${kind === 'open' ? 'Try again.' : 'Check the disk, then restart the machine.'}`);
      expect(error.message).not.toContain('next save');
      expect(error).toMatchObject({ code: 'EIO', kind, dir: '/data/x' });
    });
  }
});
