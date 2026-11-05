import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ files: 0 }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({
  ...(await orig<object>()),
  queuedFileWrites: () => h.files,
}));

import { drainForExit, isClosedForExit } from '../../src/bot/internalSetup/utils/dataManager';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { setBackendKind } from '../helpers/backendKind';

// Its own file: the exit drain runs once per process. A store that never answers and files that never land: the
// drain refuses writes from 4/5 of its bound on, ends at the bound, and names what it left.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setBackendKind(null);
});

describe('an exit drain whose writes never land', () => {
  it('closes writes at 4/5 of the bound, ends at the bound and names the guilds and files it left', async () => {
    setBackendKind('postgres');
    const store = new FakeStore();
    store.holding = true;
    const ws = initWorkingSet(store);
    for (const g of ['91002', '91001']) {
      expect(await ws.hydrate(g, tokenFor())).toBe('ready');
      expect(ws.save(g, 'm', 'a.json', '1')).toBe('accepted');
    }
    h.files = 2;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let done = false;
    const drain = drainForExit(10_000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(isClosedForExit()).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(isClosedForExit()).toBe(true);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(done).toBe(true);
    await drain;
    expect(warn.mock.calls).toEqual([
      ['[Data] Shutdown drain left 2 guild(s) with unflushed writes: 91002, 91001'],
      ['[Data] Shutdown drain left 2 file(s) with queued writes'],
    ]);
    h.files = 0;
    store.release();
  });
});
