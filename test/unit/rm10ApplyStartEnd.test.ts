import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// onApplyStartEnded in src/bot/internalSetup/utils/moduleApply.ts: when a rejected start of an unregistered module
// takes the store mutex, over NB6's apply rig.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import path from 'path';
import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { endStart, startModule } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };

beforeEach(() => rig.setup());
afterEach(async () => {
  setStoppedServingHook(null);
  await rig.teardown();
});

describe("a rejected boot start of an apply whose module is not registered", () => {
  it('holds the store mutex from the moment the start ends, so a caller in the same tick sees the previous version back', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.duringLoad = () => { setStoppedServingHook(() => true); };
    expect(await rig.apply('m', u)).toMatchObject({ outcome: 'deferred', reason: 'stopped-serving' });
    setStoppedServingHook(null);
    fakeLoader.duringLoad = null;
    expect(rig.entry('m')?.applying).toMatchObject({ from: s, to: u });
    const start = startModule('m', u, '2.0.0', path.join(rig.state.source, 'm'), { boot: true });
    if (typeof start === 'string') throw new Error(start);
    expect(getModuleRegistry().getModule('m')).toBeUndefined();

    const ended = endStart(start, { rejected: new Error('boom') });
    const hold = await storeMutex.acquire();
    if (!hold) throw new Error('the test could not take the store mutex');
    let seen;
    try {
      seen = rig.entry('m');
    } finally {
      hold.release();
    }
    await ended;
    expect(seen).toMatchObject({ sha: s, failedSha: u, applying: null });
    expect(rig.live('m')).toEqual(S_FILES);
  });
});
