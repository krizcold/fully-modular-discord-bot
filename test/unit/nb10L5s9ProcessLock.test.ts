import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 L5 survivors in processLock.ts: the holder parse, the process start, the take loop, the takeover guard and
// the release answers, read through the lock file's bytes and the answers a taker sees.

const BOOT = '/proc/sys/kernel/random/boot_id';
const STAT = '/proc/4242/stat';

const h = vi.hoisted(() => ({
  boot: [] as Array<string | Error>,
  stat: null as string | null,
  open: null as null | ((file: string, flags: unknown) => void),
  read: null as null | ((file: string) => void),
  unlink: null as null | ((file: string, real: (f: string) => void) => boolean),
  lockFds: new Set<number>(),
}));

vi.mock('fs', async (orig) => {
  const real = await orig<any>();
  const isLock = (file: unknown) => path.basename(String(file)) === 'nb10L5s9.lock';
  const wrapped = {
    ...real,
    readFileSync: (file: any, ...rest: any[]) => {
      if (file === BOOT) {
        const next = h.boot.shift();
        if (next === undefined) throw Object.assign(new Error('ENOENT: no boot id'), { code: 'ENOENT' });
        if (next instanceof Error) throw next;
        return `${next}\n`;
      }
      if (file === STAT) {
        if (h.stat === null) throw Object.assign(new Error('ENOENT: no stat'), { code: 'ENOENT' });
        return h.stat;
      }
      if (typeof file === 'string' && file.startsWith('/proc/')) throw Object.assign(new Error('ENOENT: no proc'), { code: 'ENOENT' });
      h.read?.(String(file));
      return real.readFileSync(file, ...rest);
    },
    openSync: (file: any, flags: any, ...rest: any[]) => {
      h.open?.(String(file), flags);
      const fd = real.openSync(file, flags, ...rest);
      if (isLock(file) && flags === 'wx') h.lockFds.add(fd);
      return fd;
    },
    closeSync: (fd: any) => {
      h.lockFds.delete(fd);
      return real.closeSync(fd);
    },
    unlinkSync: (file: any) => {
      if (h.unlink && h.unlink(String(file), (f) => real.unlinkSync(f))) return undefined;
      return real.unlinkSync(file);
    },
  };
  return { ...wrapped, default: wrapped };
});

import fs from 'fs';
import { ProcessLock, parseHolder, realSeams } from '../../src/bot/internalSetup/utils/processLock';
import { dataPath } from '../../src/utils/dataRoot';

const LOCK = dataPath('nb10L5s9.lock');
const GUARD = `${LOCK}.takeover`;
const isLock = (file: string) => path.basename(file) === 'nb10L5s9.lock';
const isGuard = (file: string) => path.basename(file) === 'nb10L5s9.lock.takeover';
const live = new Set<number>([101]);
let clock = Date.now();
const lock = (pid = 101) => new ProcessLock({
  lockPath: LOCK, takeoverPath: GUARD, unparsableStaleMs: 10_000, takeoverStaleMs: 5_000,
  seams: { pid: () => pid, alive: p => live.has(p), startOf: () => null, now: () => clock },
});
const deadHolder = JSON.stringify({ pid: 999, start: null });

beforeEach(() => {
  h.boot = [];
  h.stat = null;
  h.open = h.read = h.unlink = null;
  h.lockFds.clear();
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.rmSync(LOCK, { force: true });
  fs.rmSync(GUARD, { force: true });
  clock = Date.now();
});

afterEach(() => {
  h.open = h.read = h.unlink = null;
  for (const fd of h.lockFds) { try { fs.closeSync(fd); } catch { /* closed */ } }
  vi.restoreAllMocks();
});

describe('processStart names one run of a process', () => {
  // 19 fields after the state; the start time is the 20th field after the command name, which holds a space.
  const statText = `4242 (my proc) S ${Array.from({ length: 18 }, (_, i) => String(i + 1)).join(' ')} 987654 x y\n`;
  const freshStart = async () => {
    vi.resetModules();
    return (await import('../../src/bot/internalSetup/utils/processLock')).processStart;
  };

  it('joins the boot id read once with the start time after the command name', async () => {
    const start = await freshStart();
    h.boot = ['BOOTA', 'BOOTB'];
    h.stat = statText;
    expect(start.startOf(4242)).toBe('BOOTA:987654');
    expect(start.startOf(4242)).toBe('BOOTA:987654');
    expect(h.boot).toEqual(['BOOTB']);
  });

  it('a boot id that cannot be read is remembered as none and the start keeps an empty prefix', async () => {
    const start = await freshStart();
    h.boot = [Object.assign(new Error('EACCES: refused'), { code: 'EACCES' }), 'BOOTB'];
    h.stat = statText;
    expect(start.startOf(4242)).toBe(':987654');
    expect(start.startOf(4242)).toBe(':987654');
    expect(h.boot).toEqual(['BOOTB']);
  });

  it('a stat with no start time answers null', async () => {
    const start = await freshStart();
    h.boot = ['BOOTA'];
    h.stat = '4242 (x) S 1 2\n';
    expect(start.startOf(4242)).toBeNull();
    expect(start.startOf(777)).toBeNull();
  });
});

describe('realSeams.alive', () => {
  it('only ESRCH proves a pid gone', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementation(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
    expect(realSeams.alive(4242)).toBe(true);
    kill.mockImplementation(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });
    expect(realSeams.alive(4242)).toBe(false);
  });
});

describe('parseHolder', () => {
  it('takes a positive integer pid only', () => {
    expect(parseHolder('{"pid":5}')).toEqual({ pid: 5, start: null, role: undefined, at: undefined });
    expect(parseHolder('null')).toBeNull();
    expect(parseHolder('{"pid":"5"}')).toBeNull();
    expect(parseHolder('{"pid":1.5}')).toBeNull();
    expect(parseHolder('{"pid":0}')).toBeNull();
    expect(parseHolder('{"pid":-3}')).toBeNull();
  });

  it('keeps role and at only when they have their types', () => {
    const odd = parseHolder('{"pid":5,"role":7,"at":"x"}')!;
    expect(odd.role).toBeUndefined();
    expect(odd.at).toBeUndefined();
    const good = parseHolder('{"pid":5,"start":"b:1","role":"bot","at":123}')!;
    expect(good).toEqual({ pid: 5, start: 'b:1', role: 'bot', at: 123 });
  });
});

describe('tryTake answers', () => {
  it('a create error with no code answers unwritable EIO', () => {
    h.open = (file, flags) => { if (isLock(file) && flags === 'wx') throw new Error('no code'); };
    expect(lock().tryTake()).toEqual({ kind: 'unwritable', errno: 'EIO', error: expect.any(Error) });
    expect(fs.existsSync(LOCK)).toBe(false);
  });

  it('a create that throws a value with no fields answers unwritable EIO, never a throw', () => {
    h.open = (file, flags) => { if (isLock(file) && flags === 'wx') throw undefined; };
    expect(lock().tryTake()).toMatchObject({ kind: 'unwritable', errno: 'EIO' });
  });

  it('closes the lock file it created', () => {
    const l = lock();
    expect(l.tryTake()).toEqual({ kind: 'taken' });
    expect(h.lockFds.size).toBe(0);
    expect(JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid).toBe(101);
  });

  it('a read of the lock that throws a value with no fields answers unreadable EIO', () => {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 101, start: null }));
    h.read = (file) => { if (isLock(file)) throw undefined; };
    expect(lock(202).tryTake()).toEqual({ kind: 'unreadable', errno: 'EIO' });
  });

  it('an unparsable lock exactly as old as the limit is still held', () => {
    fs.writeFileSync(LOCK, 'garbage');
    fs.utimesSync(LOCK, 1_700_000_000, 1_700_000_000);
    clock = 1_700_000_000_000 + 10_000;
    expect(lock().tryTake()).toEqual({ kind: 'held', holder: null });
    expect(fs.readFileSync(LOCK, 'utf8')).toBe('garbage');
    clock += 1;
    expect(lock().tryTake()).toEqual({ kind: 'taken' });
  });

  it('a create that keeps meeting a lock that is gone answers held after three tries', () => {
    let refused = 0;
    h.open = (file, flags) => {
      if (isLock(file) && flags === 'wx' && refused < 3) { refused++; throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); }
    };
    expect(lock().tryTake()).toEqual({ kind: 'held', holder: null });
    expect(refused).toBe(3);
    expect(fs.existsSync(LOCK)).toBe(false);
  });

  it('a takeover that removed the stale lock is not reported as contended', () => {
    fs.writeFileSync(LOCK, deadHolder);
    h.open = (file, flags) => { if (isLock(file) && flags === 'wx') throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); };
    expect(lock().tryTake()).toEqual({ kind: 'held', holder: null });
    expect(fs.existsSync(LOCK)).toBe(false);
    expect(fs.existsSync(GUARD)).toBe(false);
  });
});

describe('the takeover guard', () => {
  it('a guard create refused with EACCES answers unwritable and keeps the stale lock', () => {
    fs.writeFileSync(LOCK, deadHolder);
    h.open = (file, flags) => { if (isGuard(file) && flags === 'wx') throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    expect(lock().tryTake()).toMatchObject({ kind: 'unwritable', errno: 'EACCES' });
    expect(fs.readFileSync(LOCK, 'utf8')).toBe(deadHolder);
  });

  it('a guard create that throws a value with no fields answers unwritable EIO', () => {
    fs.writeFileSync(LOCK, deadHolder);
    h.open = (file, flags) => { if (isGuard(file) && flags === 'wx') throw undefined; };
    expect(lock().tryTake()).toMatchObject({ kind: 'unwritable', errno: 'EIO' });
    expect(fs.readFileSync(LOCK, 'utf8')).toBe(deadHolder);
  });

  it('a guard exactly as old as the limit is kept and the take answers contended', () => {
    fs.writeFileSync(LOCK, deadHolder);
    fs.writeFileSync(GUARD, '');
    fs.utimesSync(GUARD, 1_700_000_000, 1_700_000_000);
    clock = 1_700_000_000_000 + 5_000;
    expect(lock().tryTake()).toEqual({ kind: 'contended' });
    expect(fs.existsSync(GUARD)).toBe(true);
    expect(fs.readFileSync(LOCK, 'utf8')).toBe(deadHolder);
  });

  it('a stale lock that vanishes under the takeover unlink is taken', () => {
    fs.writeFileSync(LOCK, deadHolder);
    h.unlink = (file, real) => {
      if (!isLock(file)) return false;
      h.unlink = null;
      real(file);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(lock().tryTake()).toEqual({ kind: 'taken' });
    expect(JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid).toBe(101);
  });

  it('a takeover unlink that throws a value with no fields answers unwritable EIO', () => {
    fs.writeFileSync(LOCK, deadHolder);
    h.unlink = (file) => { if (isLock(file)) throw undefined; return false; };
    expect(lock().tryTake()).toMatchObject({ kind: 'unwritable', errno: 'EIO' });
    expect(fs.readFileSync(LOCK, 'utf8')).toBe(deadHolder);
    expect(fs.existsSync(GUARD)).toBe(false);
  });
});

describe('release and unlinkIfText', () => {
  it('a release with nothing held leaves a lock naming this pid', () => {
    const text = JSON.stringify({ pid: 101, start: null });
    fs.writeFileSync(LOCK, text);
    const l = lock();
    expect(l.release()).toBeNull();
    expect(l.depth).toBe(0);
    expect(fs.readFileSync(LOCK, 'utf8')).toBe(text);
  });

  it('a release whose lock file is already gone answers null', () => {
    const l = lock();
    expect(l.tryTake()).toEqual({ kind: 'taken' });
    fs.rmSync(LOCK);
    expect(l.release()).toBeNull();
  });

  it('a release whose read throws a value with no fields answers EIO', () => {
    const l = lock();
    expect(l.tryTake()).toEqual({ kind: 'taken' });
    h.read = (file) => { if (isLock(file)) throw undefined; };
    expect(l.release()).toBe('EIO');
    h.read = null;
    expect(fs.existsSync(LOCK)).toBe(true);
  });

  it('unlinkIfText on a missing file answers null and on a read that throws no fields answers EIO', () => {
    expect(lock().unlinkIfText('x')).toBeNull();
    fs.writeFileSync(LOCK, 'x');
    h.read = (file) => { if (isLock(file)) throw undefined; };
    expect(lock().unlinkIfText('x')).toBe('EIO');
    h.read = null;
    expect(fs.readFileSync(LOCK, 'utf8')).toBe('x');
  });
});
