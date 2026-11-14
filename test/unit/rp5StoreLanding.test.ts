import { createHash } from 'crypto';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import {
  _resetRowQueue, deposeRows, dropOwedStoreDoc, landStoreDoc, reopenRows, useStoreLanding,
} from '../../src/bot/internalSetup/utils/sharedStore';
import { readStoreRecord, storeRecordPath, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';

const KEY = 'global/appstore/rp5.json';
const FILE = dataPath('global', 'appstore', 'rp5.json');
const A = Buffer.from('{"v":"a"}');
const B = Buffer.from('{"v":"b"}');
const C = Buffer.from('{"v":"c"}');
const D = Buffer.from('{"v":"d"}');
const X = Buffer.from('{"v":"edited by hand"}');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const PREVIOUS = (errno: string) => `[Shared] ${FILE} is stored in the database, but this machine could not write its copy (${errno}); the App Store on this machine shows the previous version until it is written, and it tries again`;
const MOVED = (errno: string) => `[Shared] ${FILE} is stored in the database, but this machine could not write its copy (${errno}); its previous copy was moved aside, and it tries again`;

let warns: string[];
let errors: string[];
let writeFault: string | null;
let unlinkFault: { value: unknown } | null;

beforeEach(() => {
  warns = [];
  errors = [];
  writeFault = null;
  unlinkFault = null;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  _resetRowQueue();
  useStoreLanding(null);
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const openSync = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (writeFault && String(p).startsWith(`${FILE}.`)) throw Object.assign(new Error(`${writeFault}: refused`), { code: writeFault });
    return (openSync as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
  const unlinkSync = fs.unlinkSync;
  vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
    if (unlinkFault && path.resolve(String(p)) === path.resolve(FILE)) throw unlinkFault.value;
    return unlinkSync(p);
  }) as typeof fs.unlinkSync);
});

afterEach(() => {
  reopenRows();
  _resetRowQueue();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mirror = (bytes: Buffer) => fs.writeFileSync(FILE, bytes);
const held = (): Buffer | null => (fs.existsSync(FILE) ? fs.readFileSync(FILE) : null);
const setEntry = (entrySha: string | null) => {
  writeStoreRecord({ docs: entrySha === null ? {} : { [KEY]: { sha: entrySha, stamp: null, main: null } }, modules: {} });
};
const entry = () => {
  const record = readStoreRecord();
  if (!record.ok) throw new Error(record.reason);
  return record.record.docs[KEY];
};
const superseded = () => fs.existsSync(dataPath('_superseded'));
const failWrites = (errno: string | null) => { writeFault = errno; };

describe('rp5: the landing of an App Store doc (writeStoreKey)', () => {
  it('a mirror that already holds the stored bytes is neither moved aside nor rewritten (rp5-7)', () => {
    mirror(B);
    setEntry(sha(A));
    landStoreDoc(KEY, B, sha(B), null);
    expect(warns).toEqual([]);
    expect(superseded()).toBe(false);
    expect(held()!.equals(B)).toBe(true);
    expect(entry()).toEqual({ sha: sha(B), stamp: null, main: null });
  });

  it('a mirror that already holds the stored bytes needs no write, so a full disk changes nothing (rp5-8, rp5-10)', () => {
    mirror(B);
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    expect(errors).toEqual([]);
    expect(held()!.equals(B)).toBe(true);
    expect(entry()).toEqual({ sha: sha(B), stamp: null, main: null });
  });

  it('a removal of a mirror edited by hand moves it aside and says nothing was put back (rp5-12, rp5-14, rp5-16, rp5-18)', () => {
    mirror(X);
    setEntry(sha(A));
    landStoreDoc(KEY, null, 'absent', null);
    expect(errors).toEqual([]);
    expect(warns).toHaveLength(1);
    const match = /^\[Shared\] Moved (.+) to (.+): it differed from the version this machine last took from the database \(changed outside the bot, or left by a crash\); (.+)$/.exec(warns[0]);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(FILE);
    expect(match![3]).toBe('the database holds no such file, so nothing was put back');
    expect(fs.readFileSync(match![2]).equals(X)).toBe(true);
    expect(held()).toBeNull();
    expect(entry()).toBeUndefined();
  });

  it('a removal whose unlink is refused keeps the file and the entry, logs the errno and tries again (rp5-11, rp5-13, rp5-14)', () => {
    mirror(A);
    setEntry(sha(A));
    unlinkFault = { value: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) };
    landStoreDoc(KEY, null, 'absent', null);
    expect(errors).toEqual([PREVIOUS('EACCES')]);
    expect(held()!.equals(A)).toBe(true);
    expect(entry()).toEqual({ sha: sha(A), stamp: null, main: null });
    unlinkFault = null;
    vi.advanceTimersByTime(1000);
    expect(held()).toBeNull();
    expect(entry()).toBeUndefined();
  });

  it('an unlink that throws a bare null is logged as null (rp5-15)', () => {
    mirror(A);
    setEntry(sha(A));
    unlinkFault = { value: null };
    landStoreDoc(KEY, null, 'absent', null);
    expect(errors).toEqual([PREVIOUS('null')]);
    expect(held()!.equals(A)).toBe(true);
  });

  it('a write after a failed move aside clears the moved state: the next failure says the previous version shows (rp5-17)', () => {
    mirror(X);
    setEntry(sha(A));
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    expect(errors).toEqual([MOVED('ENOSPC')]);
    failWrites(null);
    landStoreDoc(KEY, B, sha(B), null);
    expect(held()!.equals(B)).toBe(true);
    failWrites('ENOSPC');
    landStoreDoc(KEY, C, sha(C), null);
    expect(errors).toEqual([MOVED('ENOSPC'), PREVIOUS('ENOSPC')]);
  });

  it("a pass's drop of the owed write clears the moved state too (rp5-34)", () => {
    mirror(X);
    setEntry(sha(A));
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    expect(errors).toEqual([MOVED('ENOSPC')]);
    dropOwedStoreDoc(KEY);
    landStoreDoc(KEY, C, sha(C), null);
    expect(errors).toEqual([MOVED('ENOSPC'), PREVIOUS('ENOSPC')]);
  });
});

describe('rp5: the retry of an owed App Store doc (tryStoreDoc)', () => {
  it('an entry that changed from one version to another since the failed write drops the owed write (rp5-19)', () => {
    mirror(A);
    setEntry(sha(A));
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    mirror(C);
    setEntry(sha(C));
    failWrites(null);
    vi.advanceTimersByTime(60_000);
    expect(held()!.equals(C)).toBe(true);
    expect(entry()).toEqual({ sha: sha(C), stamp: null, main: null });
  });

  it('an entry that appeared since the failed write drops the owed write, whatever sha it holds (rp5-20)', () => {
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    setEntry('');
    failWrites(null);
    vi.advanceTimersByTime(60_000);
    expect(held()).toBeNull();
    expect(entry()).toEqual({ sha: '', stamp: null, main: null });
  });

  it('a store record that cannot be read at the retry keeps the write owed and logs why (rp5-21, rp5-24, rp5-25)', () => {
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    expect(errors).toEqual([PREVIOUS('ENOSPC')]);
    fs.mkdirSync(path.dirname(storeRecordPath()), { recursive: true });
    fs.writeFileSync(storeRecordPath(), 'not json');
    vi.advanceTimersByTime(1000);
    expect(errors).toHaveLength(2);
    expect(errors[1]).toBe(PREVIOUS(`${storeRecordPath()} is not JSON`));
    fs.rmSync(storeRecordPath());
    failWrites(null);
    vi.advanceTimersByTime(2000);
    expect(held()!.equals(B)).toBe(true);
    expect(entry()).toEqual({ sha: sha(B), stamp: null, main: null });
  });

  it('a publish landed after another process took the data files is not owed: the earlier retry writes its own version (rp5-22)', () => {
    mirror(A);
    setEntry(sha(A));
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    deposeRows('another process');
    landStoreDoc(KEY, C, sha(C), null);
    reopenRows();
    failWrites(null);
    vi.advanceTimersByTime(1000);
    expect(held()!.equals(B)).toBe(true);
  });

  it('a retry that fires after another process took the data files writes nothing (rp5-23)', () => {
    mirror(A);
    setEntry(sha(A));
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    deposeRows('another process');
    failWrites(null);
    vi.advanceTimersByTime(60_000);
    expect(held()!.equals(A)).toBe(true);
    expect(entry()).toEqual({ sha: sha(A), stamp: null, main: null });
  });

  it('an entry changed since the failed write drops the owed write with its log state: the same errno is logged again (rp5-26)', () => {
    mirror(A);
    setEntry(sha(A));
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    mirror(C);
    setEntry(sha(C));
    vi.advanceTimersByTime(1000);
    expect(held()!.equals(C)).toBe(true);
    landStoreDoc(KEY, D, sha(D), null);
    expect(errors).toEqual([PREVIOUS('ENOSPC'), PREVIOUS('ENOSPC')]);
  });

  it('the retry waits double after each failed try (rp5-27, rp5-28)', () => {
    mirror(A);
    setEntry(sha(A));
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    vi.advanceTimersByTime(999);
    failWrites(null);
    vi.advanceTimersByTime(1000);
    expect(held()!.equals(A)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(held()!.equals(B)).toBe(true);
  });

  it('a landed doc is no longer owed: a retry timer left from its earlier failure writes nothing (rp5-30, rp5-31)', () => {
    mirror(A);
    setEntry(sha(A));
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    failWrites(null);
    landStoreDoc(KEY, C, sha(C), null);
    expect(held()!.equals(C)).toBe(true);
    mirror(A);
    setEntry(sha(A));
    vi.advanceTimersByTime(60_000);
    expect(held()!.equals(A)).toBe(true);
    expect(entry()).toEqual({ sha: sha(A), stamp: null, main: null });
  });

  it('a write that worked starts the backoff over (rp5-32)', () => {
    mirror(A);
    setEntry(sha(A));
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    failWrites(null);
    vi.advanceTimersByTime(1000);
    expect(held()!.equals(B)).toBe(true);
    failWrites('ENOSPC');
    landStoreDoc(KEY, C, sha(C), null);
    failWrites(null);
    vi.advanceTimersByTime(1000);
    expect(held()!.equals(C)).toBe(true);
  });

  it('a write that worked lets the same errno be logged again (rp5-33)', () => {
    mirror(A);
    setEntry(sha(A));
    failWrites('ENOSPC');
    landStoreDoc(KEY, B, sha(B), null);
    failWrites(null);
    landStoreDoc(KEY, B, sha(B), null);
    expect(held()!.equals(B)).toBe(true);
    failWrites('ENOSPC');
    landStoreDoc(KEY, C, sha(C), null);
    expect(errors).toEqual([PREVIOUS('ENOSPC'), PREVIOUS('ENOSPC')]);
  });
});
