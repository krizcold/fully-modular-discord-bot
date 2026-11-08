import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 43 (wip-redesign/sheets/NB6.md decisions 36, 43 and 61): rows 113 and 114. During an apply's await the
// store lock is free (each synchronous part takes it and gives it back), a same-process App Store section waits on the
// store mutex (60 s, then lockBusyError's text), and a `locked()` caller takes the store lock at once.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { storeMutex, takeStoreMutex, withStoreLock } from '../../src/bot/internalSetup/utils/appStoreManager';

const rig = applyRig();
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };

beforeEach(() => rig.setup());
afterEach(() => rig.teardown());

describe('row 113: a same-process App Store write during an apply', () => {
  it('waits on the store mutex; past 60 s it answers lockBusyError\'s text', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const outcomes: string[] = [];
    let waited: Promise<void> | null = null;
    fakeLoader.duringLoad = () => {
      waited = takeStoreMutex().then(hold => { outcomes.push('held'); hold.release(); }, (error: Error) => { outcomes.push(error.message); });
    };
    const result = await rig.apply('m', u);
    expect(result.outcome).toBe('applied');
    await waited;
    expect(outcomes).toEqual(['held']);

    vi.useFakeTimers();
    const hold = await storeMutex.acquire();
    const late = takeStoreMutex().then(() => 'held', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(60_001);
    const message = await late;
    hold!.release();
    expect(message).toBe('Another App Store change is still running, so nothing was changed. Try again in a minute.');
  });
});

describe('row 114: the store lock during the apply\'s fetch, compile and load', () => {
  it('is free: a locked() caller takes it at once', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const taken: number[] = [];
    fakeLoader.duringLoad = () => {
      const t0 = Date.now();
      withStoreLock(() => { taken.push(Date.now() - t0); });
    };
    await rig.apply('m', u);
    expect(taken).toHaveLength(1);
    expect(taken[0]).toBeLessThan(1000);
  });
});
