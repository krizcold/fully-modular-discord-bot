import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation survivors (chunk 8): maintenance's save (saveHeldWrites) runs the exit drain's loop. It keeps flushing
// while a flush is on the wire, gives up once nothing landed for 3 s with nothing on the wire, answers as soon as
// nothing is held, and starts no flush once its bound has passed. The working set is a stub the test drives.

const st = vi.hoisted(() => ({ settled: false, onWire: false, landed: 0, flushCalls: 0, settleOnCall: Infinity }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/workingSet')>();
  const stub = {
    writesSettled: () => st.settled,
    flushOnTheWire: () => st.onWire,
    flushAllDirty: () => {
      st.flushCalls++;
      if (st.flushCalls >= st.settleOnCall) st.settled = true;
      return Promise.resolve([] as string[]);
    },
    landedFlushes: () => st.landed,
    dirtyGuildIds: () => (st.settled ? [] : ['100']),
  };
  return { ...real, getWorkingSet: () => stub };
});

import { saveHeldWrites } from '../../src/bot/internalSetup/utils/dataManager';

function track<T>(p: Promise<T>): { done: () => boolean; value: () => T | undefined } {
  let done = false;
  let value: T | undefined;
  void p.then(v => { done = true; value = v; });
  return { done: () => done, value: () => value };
}

beforeEach(() => {
  Object.assign(st, { settled: false, onWire: false, landed: 0, flushCalls: 0, settleOnCall: Infinity });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('maintenance save over a working set that does not settle', () => {
  it('gives up after 3 s with nothing landed and nothing on the wire, and answers the guild still held', async () => {
    const run = track(saveHeldWrites(10_000));
    await vi.advanceTimersByTimeAsync(2_800);
    expect(run.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(run.done()).toBe(true);
    expect(run.value()).toEqual({ unsavedGuilds: 1, unsavedFiles: 0 });
  });

  it('keeps waiting while a flush is on the wire, up to its bound', async () => {
    st.onWire = true;
    const run = track(saveHeldWrites(10_000));
    await vi.advanceTimersByTimeAsync(3_300);
    expect(run.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(run.done()).toBe(true);
    expect(run.value()).toEqual({ unsavedGuilds: 1, unsavedFiles: 0 });
  });

  it('retries a store that settles on its third pass and answers nothing held', async () => {
    st.settleOnCall = 3;
    const run = track(saveHeldWrites(10_000));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.done()).toBe(true);
    expect(run.value()).toEqual({ unsavedGuilds: 0, unsavedFiles: 0 });
    expect(st.flushCalls).toBe(3);
  });

  it('answers as soon as one pass saved everything, without a poll pause', async () => {
    st.settleOnCall = 1;
    const run = track(saveHeldWrites(10_000));
    await vi.advanceTimersByTimeAsync(50);
    expect(run.done()).toBe(true);
    expect(run.value()).toEqual({ unsavedGuilds: 0, unsavedFiles: 0 });
  });

  it('starts no flush when its bound has already passed', async () => {
    const pending = saveHeldWrites(0);
    expect(st.flushCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual({ unsavedGuilds: 1, unsavedFiles: 0 });
    expect(st.flushCalls).toBe(0);
  });
});
