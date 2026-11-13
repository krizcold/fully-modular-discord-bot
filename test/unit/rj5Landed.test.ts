import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushAll, saveHeldWrites, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import type { DataBackend } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { _resetRowQueue, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { FakeStore } from '../helpers/fakeStore';

// L5 run A, chunk rj5: the drain's progress counts a working set flush and a row op landing alike, and only the exit
// drain names the guilds whose set is pending a re-save.

let ws: WorkingSetManager;
let warns: string[];

beforeAll(() => {
  ws = initWorkingSet(new FakeStore());
});

beforeEach(() => {
  _resetRowQueue();
  setGuildDataBackend(null);
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setGuildDataBackend(null);
  _resetRowQueue();
});

describe("the drain's progress", () => {
  it('a working set flush and a row op landing in the same pass are progress: the give-up window starts again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let setFlushes = 0;
    vi.spyOn(ws, 'writesSettled').mockReturnValue(false);
    vi.spyOn(ws, 'flushOnTheWire').mockReturnValue(false);
    vi.spyOn(ws, 'flushAllDirty').mockResolvedValue([]);
    vi.spyOn(ws, 'landedFlushes').mockImplementation(() => setFlushes);
    const answers: Array<(outcome: unknown) => void> = [];
    const sharedTx = vi.fn(() => new Promise(resolve => { answers.push(resolve); }));
    rowQueue.acceptWork('rj5:landed:1', '/rj5/landed.jsonl', { bytes: 1, spec: () => ({}) as never });
    setGuildDataBackend({ sharedTx } as unknown as DataBackend);
    for (let i = 0; i < 50 && sharedTx.mock.calls.length === 0; i++) await Promise.resolve();
    expect(sharedTx).toHaveBeenCalledTimes(1);

    let done = false;
    void saveHeldWrites(20_000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(2_900);
    setFlushes += 1;
    answers.shift()!({ kind: 'committed' });
    await vi.advanceTimersByTimeAsync(1);
    expect(rowQueue.keys()).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(done).toBe(true);
  });
});

describe('the guilds pending a re-save', () => {
  it('a full flush does not name them; that line is the exit drain\'s', async () => {
    vi.spyOn(ws, 'resaveGuilds').mockReturnValue(['5200000000000000001']);
    vi.spyOn(ws, 'flushAllDirty').mockResolvedValue([]);
    await flushAll();
    expect(warns.filter(w => w.includes('not re-saved'))).toEqual([]);
  });
});
