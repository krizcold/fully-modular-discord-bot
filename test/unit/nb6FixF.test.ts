import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 code review round 1, lane F finding 3 and lane C findings 6 (T30) and 8 (the apply half), with the fake loader
// and a scripted compile over the rows the real publish writes.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { publisherAnswer } from '../../src/bot/internalSetup/utils/moduleApply';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const FAILING = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n', 'fail.txt': 'index.js threw: boom' };

beforeEach(() => rig.setup());
afterEach(async () => {
  setStoppedServingHook(null);
  await rig.teardown();
});

describe("lane F finding 3: the restored version's load fails because this process stopped serving", () => {
  it("no status row for the previous version, no T3; the apply ends 'deferred' 'stopped-serving'", async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    let loads = 0;
    fakeLoader.duringLoad = () => {
      loads += 1;
      if (loads === 2) setStoppedServingHook(() => true);
    };
    const result = await rig.apply('m', u, { version: '2.0.0' });
    expect(result).toMatchObject({ outcome: 'deferred', reason: 'stopped-serving' });
    expect(rig.state.lines.some(l => l.includes('the previous version did not load either'))).toBe(false);
    expect(rig.status('m').some(row => String(row.error ?? '').includes('did not load either'))).toBe(false);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u, applying: null });
  });
});

describe("lane C finding 8: an uninstall whose unload fails", () => {
  it('answers unloadFailed with the error', async () => {
    await rig.inPlace('m', S_FILES);
    fakeLoader.unloadFails = 'a listener would not detach';
    const result = await rig.apply('m', 'absent');
    expect(result).toMatchObject({ outcome: 'applied', unloadFailed: 'a listener would not detach' });
  });

  it('carries no unloadFailed when the unload succeeds', async () => {
    await rig.inPlace('m', S_FILES);
    const result = await rig.apply('m', 'absent');
    expect(result).toEqual({ outcome: 'applied', reason: null, error: null, loaded: false });
  });
});

describe("lane C finding 6: T30", () => {
  it("names what the App Store tab lists", () => {
    const answer = publisherAnswer('update', 'm', '2.0.0', { outcome: 'loaded', reason: null, error: null, loaded: true });
    expect(answer.text).toBe('m 2.0.0 was updated and loaded on this machine, and its start-up code is still running. The App Store tab lists this machine if that code fails within 10 minutes; this machine then keeps no copy of m.');
  });
});
