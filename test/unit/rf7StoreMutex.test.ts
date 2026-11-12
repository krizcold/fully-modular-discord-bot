import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { appStoreConfigPath } from '../../src/bot/internalSetup/utils/appStoreConfigFile';
import { StoreWriteError, awaitStoreDoc, storeFileSha, storeMutex, watchStoreDoc, type StoreMutexHold } from '../../src/bot/internalSetup/utils/appStoreManager';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('the store mutex', () => {
  it('a waiter that was granted the hold leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = (await storeMutex.acquire())!;
    const waiting = storeMutex.acquire(30_000);
    expect(vi.getTimerCount()).toBe(1);
    first.release();
    const second = await waiting;
    expect(second).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    second!.release();
  });

  it('works where setTimeout gives a numeric id with no unref', async () => {
    const realSet = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => Number(realSet(fn, ms))) as never);
    const first = (await storeMutex.acquire())!;
    const waiting = storeMutex.acquire(5_000);
    first.release();
    const second = await waiting;
    expect(second).not.toBeNull();
    second!.release();
  });

  it('a second release of the same hold hands nothing on', async () => {
    const first = (await storeMutex.acquire())!;
    const granted: string[] = [];
    const holds: Record<string, StoreMutexHold> = {};
    const b = storeMutex.acquire(5_000).then(h => { granted.push('b'); holds.b = h!; });
    const c = storeMutex.acquire(5_000).then(h => { granted.push('c'); holds.c = h!; });
    first.release();
    first.release();
    await b;
    await settle();
    expect(granted).toEqual(['b']);
    holds.b.release();
    await c;
    expect(granted).toEqual(['b', 'c']);
    holds.c.release();
    const after = (await storeMutex.acquire(5_000))!;
    expect(after).not.toBeNull();
    after.release();
  });

  it('a second release of the last hold leaves the mutex free once, not twice', async () => {
    const first = (await storeMutex.acquire())!;
    first.release();
    const again = (await storeMutex.acquire())!;
    first.release();
    let late = false;
    const waiting = storeMutex.acquire(5_000).then(h => { late = true; return h; });
    await settle();
    expect(late).toBe(false);
    again.release();
    (await waiting)!.release();
    expect(late).toBe(true);
  });
});

describe('StoreWriteError', () => {
  it('names itself in its printed form', () => {
    expect(String(new StoreWriteError(409, 'config.json was changed'))).toBe('StoreWriteError: config.json was changed');
  });
});

describe('storeFileSha', () => {
  it('a read that throws a value with no code refuses the write with the 500 text', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw undefined; });
    let thrown: unknown;
    try {
      storeFileSha(appStoreConfigPath());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StoreWriteError);
    expect((thrown as StoreWriteError).status).toBe(500);
    expect((thrown as Error).message).toBe('config.json could not be read (undefined), so nothing was saved.');
  });
});

describe('a store write refused at the accept, awaited', () => {
  it('answers 500 with the full refusal text, not the partial one', async () => {
    const error = await awaitStoreDoc({ file: appStoreConfigPath(), refused: 'not-ready' }, 'App Store settings').catch(e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(500);
    expect(error.message).toBe("This server's data is still loading, so your change was not saved. Please try again in a moment.");
  });
});

describe('watchStoreDoc logs a refusal that came after the accept', () => {
  const refusedTicket = (refusal: Record<string, unknown>) =>
    ({ file: appStoreConfigPath(), ticket: { kind: 'row', key: 'global/appstore/config.json', seq: 1, op: { state: 'refused', refusal } } }) as never;

  async function logged(refusal: Record<string, unknown>): Promise<string[]> {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    watchStoreDoc(refusedTicket(refusal));
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 1000, interval: 2 });
    return errors;
  }

  it('a refusal other than changed-elsewhere logs its reason', async () => {
    expect(await logged({ cause: 'unstorable', reason: 'the text is over the size limit' })).toEqual([
      '[AppStoreManager] config.json was not saved: the text is over the size limit',
    ]);
  });

  it('a refusal other than changed-elsewhere with no reason logs its cause', async () => {
    expect(await logged({ cause: 'database-backlog' })).toEqual(['[AppStoreManager] config.json was not saved: database-backlog']);
  });

  it('changed-elsewhere by another machine names that machine', async () => {
    const before = process.env.NODE_NAME;
    process.env.NODE_NAME = 'ALPHA';
    try {
      const at = new Date('2026-11-12T10:00:00.000Z');
      expect(await logged({ cause: 'changed-elsewhere', by: 'BRAVO', at })).toEqual([
        '[AppStoreManager] config.json was not saved: it changed after this write read it (saved by BRAVO at 2026-11-12T10:00:00.000Z)',
      ]);
    } finally {
      if (before === undefined) delete process.env.NODE_NAME;
      else process.env.NODE_NAME = before;
    }
  });
});
