import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { _resetRowQueue, dropOwedStoreDoc, landStoreDoc, useStoreLanding, type StoreLanding } from '../../src/bot/internalSetup/utils/sharedStore';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';

// L5 run A, rp6 chunk of sharedStore.ts: an App Store doc whose mirror write failed after its own transaction stored it
// (landStoreDoc): its retry on the backoff under the store mutex, the drop when a pass wrote the key, and what a reset
// of the row queue forgets. Math.random is pinned to 0, so the backoff is exactly half its base: 500 ms, 1 s, 2 s.

const KEY = 'global/appstore/rp6.json';
const FILE = dataPath('global', 'appstore', 'rp6.json');
const A = Buffer.from('{"v":"a"}');
const B = Buffer.from('{"v":"b"}');
const X = Buffer.from('{"v":"edited by hand"}');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const SHOWS_PREVIOUS = `[Shared] ${FILE} is stored in the database, but this machine could not write its copy (ENOSPC); the App Store on this machine shows the previous version until it is written, and it tries again`;
const MOVED_PREVIOUS = `[Shared] ${FILE} is stored in the database, but this machine could not write its copy (ENOSPC); its previous copy was moved aside, and it tries again`;

let errors: string[];
let failing: { restore(): void } | null;

beforeEach(() => {
  errors = [];
  failing = null;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  _resetRowQueue();
  useStoreLanding(null);
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
});

afterEach(() => {
  failing?.restore();
  useStoreLanding(null);
  _resetRowQueue();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The mirror's own write (its temp file) fails with ENOSPC; every other open goes through. */
function failMirrorWrite(): void {
  const real = fs.openSync;
  const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    const s = String(p);
    if (s.startsWith(`${FILE}.`) && s.endsWith('.tmp')) throw Object.assign(new Error(`ENOSPC: no space left on device, open '${s}'`), { code: 'ENOSPC' });
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.openSync);
  failing = { restore: () => { spy.mockRestore(); failing = null; } };
}

const held = (): Buffer | null => (fs.existsSync(FILE) ? fs.readFileSync(FILE) : null);
const failedLines = () => errors.filter(l => l === SHOWS_PREVIOUS || l === MOVED_PREVIOUS);
const entryOf = (key: string) => {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  return read.record.docs[key];
};

interface Landing extends StoreLanding {
  acquires: number;
  locks: number;
  releases: number;
}

function landing(grant: () => boolean): Landing {
  const out: Landing = {
    acquires: 0,
    locks: 0,
    releases: 0,
    acquire: async () => {
      out.acquires += 1;
      return grant() ? { release: () => { out.releases += 1; } } : null;
    },
    locked: <T>(fn: () => T): T => {
      out.locks += 1;
      return fn();
    },
  };
  return out;
}

describe('a pass that writes an owed store key drops its owed write', () => {
  it('the same failure after the drop is logged again (rp6-1, rp6-3)', () => {
    failMirrorWrite();
    landStoreDoc(KEY, A, sha(A), null);
    expect(failedLines()).toEqual([SHOWS_PREVIOUS]);
    dropOwedStoreDoc(KEY);
    landStoreDoc(KEY, B, sha(B), null);
    expect(failedLines()).toEqual([SHOWS_PREVIOUS, SHOWS_PREVIOUS]);
    expect(held()).toBeNull();
  });

  it('a write owed after the drop starts its backoff again at the first step (rp6-2)', async () => {
    failMirrorWrite();
    landStoreDoc(KEY, A, sha(A), null);
    dropOwedStoreDoc(KEY);
    await vi.advanceTimersByTimeAsync(600);
    expect(held()).toBeNull();
    landStoreDoc(KEY, B, sha(B), null);
    failing!.restore();
    await vi.advanceTimersByTimeAsync(400);
    expect(held()).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(held()!.equals(B)).toBe(true);
    expect(entryOf(KEY)).toEqual({ sha: sha(B), stamp: null, main: null });
  });

  it('a retry that comes due after the drop does not take the store mutex (rp6-4)', async () => {
    const lock = landing(() => true);
    useStoreLanding(lock);
    failMirrorWrite();
    landStoreDoc(KEY, A, sha(A), null);
    dropOwedStoreDoc(KEY);
    failing!.restore();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lock.acquires).toBe(0);
    expect(held()).toBeNull();
  });
});

describe("the retry of an owed store key under the store mutex", () => {
  it('a mutex wait that passes its bound is tried again on a doubling backoff until the mutex is taken (rp6-5, rp6-6, rp6-7)', async () => {
    const lock = landing(() => lock.acquires >= 4);
    useStoreLanding(lock);
    failMirrorWrite();
    landStoreDoc(KEY, A, sha(A), null);
    failing!.restore();
    // The tries come due at 500 ms, then 1 s, 2 s and 4 s after the one before: 500, 1500, 3500, 7500.
    await vi.advanceTimersByTimeAsync(499);
    expect(lock.acquires).toBe(0);
    await vi.advanceTimersByTimeAsync(701);
    expect(lock.acquires).toBe(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(lock.acquires).toBe(2);
    await vi.advanceTimersByTimeAsync(1400);
    expect(lock.acquires).toBe(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(lock.acquires).toBe(3);
    expect(held()).toBeNull();
    await vi.advanceTimersByTimeAsync(4000);
    expect(lock.acquires).toBe(4);
    expect(held()!.equals(A)).toBe(true);
    expect(lock.releases).toBe(1);
  });

  it('a retry that takes the mutex writes the mirror and the entry under the store lock, then releases the mutex (rp6-8 to rp6-11)', async () => {
    const lock = landing(() => true);
    useStoreLanding(lock);
    failMirrorWrite();
    landStoreDoc(KEY, B, sha(B), 'main-1');
    expect(held()).toBeNull();
    failing!.restore();
    await vi.advanceTimersByTimeAsync(600);
    expect(lock.acquires).toBe(1);
    expect(lock.locks).toBe(1);
    expect(held()!.equals(B)).toBe(true);
    expect(entryOf(KEY)).toEqual({ sha: sha(B), stamp: null, main: 'main-1' });
    expect(lock.releases).toBe(1);
  });
});

describe('a reset of the row queue', () => {
  it('forgets the failures logged, so the same failure after it is logged again (rp6-20)', () => {
    failMirrorWrite();
    landStoreDoc(KEY, A, sha(A), null);
    _resetRowQueue();
    landStoreDoc(KEY, B, sha(B), null);
    expect(failedLines()).toEqual([SHOWS_PREVIOUS, SHOWS_PREVIOUS]);
  });

  it('forgets the tries, so a write owed after it starts at the first backoff step (rp6-19)', async () => {
    failMirrorWrite();
    landStoreDoc(KEY, A, sha(A), null);
    _resetRowQueue();
    landStoreDoc(KEY, B, sha(B), null);
    failing!.restore();
    await vi.advanceTimersByTimeAsync(400);
    expect(held()).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(held()!.equals(B)).toBe(true);
  });

  it('stops the retries due before it, so a write owed after it waits its own backoff (rp6-27)', async () => {
    failMirrorWrite();
    landStoreDoc(KEY, A, sha(A), null);
    await vi.advanceTimersByTimeAsync(400);
    _resetRowQueue();
    landStoreDoc(KEY, B, sha(B), null);
    failing!.restore();
    await vi.advanceTimersByTimeAsync(200);
    expect(held()).toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    expect(held()!.equals(B)).toBe(true);
  });

  it('forgets a mirror moved aside, so a later failure says the App Store shows the previous version (rp6-21)', () => {
    fs.writeFileSync(FILE, X);
    failMirrorWrite();
    landStoreDoc(KEY, A, sha(A), null);
    expect(failedLines()).toEqual([MOVED_PREVIOUS]);
    expect(held()).toBeNull();
    _resetRowQueue();
    landStoreDoc(KEY, B, sha(B), null);
    expect(failedLines()).toEqual([MOVED_PREVIOUS, SHOWS_PREVIOUS]);
  });
});
