import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 67 (wip-redesign/sheets/NB6.md C16 and D10), part 16's cells: 436 (stoppedServing() at 43 step 1) and 437
// (it turns true before step 5's load), through the real `applyModuleChange` over a store record a real apply wrote, with
// `setStoppedServingHook`. Cell 438 (botManager.applyModule()) is part 26's.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { deferredText, recoverModuleApplies, stoppedServingText } from '../../src/bot/internalSetup/utils/moduleApply';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };

beforeEach(() => rig.setup());
afterEach(async () => {
  setStoppedServingHook(null);
  await rig.teardown();
});

describe('cell 436: stoppedServing() at step 1', () => {
  it('ends deferred stopped-serving and touches nothing; the publisher answers T37', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const record = readStoreRecord();
    fakeLoader.loads = [];
    const compiles = fakeLoader.compileCalls;
    setStoppedServingHook(() => true);
    const result = await rig.apply('m', u, { reason: 'update' });
    expect(result).toEqual({ outcome: 'deferred', reason: 'stopped-serving', error: null, loaded: false });
    expect(readStoreRecord()).toEqual(record);
    expect(rig.live('m')).toEqual(S_FILES);
    expect(fakeLoader.loads).toEqual([]);
    expect(fakeLoader.compileCalls).toBe(compiles);
    expect(rig.entry('m')?.sha).toBe(s);
    expect(deferredText('update', 'm', '2.0.0', result)).toBeNull();
    expect(stoppedServingText('update', 'm', '2.0.0')).toBe("m 2.0.0 was updated. This machine's bot process stopped serving its shards and restarts; it tries to load the module after that restart.");
    expect(stoppedServingText('install', 'm', '2.0.0')).toBe("m 2.0.0 was installed. This machine's bot process stopped serving its shards and restarts; it tries to load the module after that restart.");
    expect(stoppedServingText('uninstall', 'm', '2.0.0')).toBe("m was uninstalled. This machine's bot process stopped serving its shards and restarts; it tries to remove the module's files after that restart.");
  });
});

describe('cell 437: stoppedServing() turns true before step 5\'s load', () => {
  it('the load throws; no failure path; the entry keeps applying; deferred; the next boot recovers with T4 and the pass applies the row', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.duringLoad = () => { setStoppedServingHook(() => true); };
    const result = await rig.apply('m', u, { reason: 'update' });
    expect(result).toMatchObject({ outcome: 'deferred', reason: 'stopped-serving', loaded: false });
    const entry = rig.entry('m');
    expect(entry?.applying).toMatchObject({ from: s, to: u });
    expect(entry).toMatchObject({ failedSha: null });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: s })]);
    expect(rig.state.lines.filter(l => l.startsWith('[Shared]'))).toEqual([]);

    // The next boot of a process that serves its shards.
    setStoppedServingHook(null);
    fakeLoader.duringLoad = null;
    recoverModuleApplies();
    expect(rig.entry('m')).toMatchObject({ sha: s });
    expect(rig.state.lines.filter(l => l.startsWith('[Shared]'))).toEqual([
      expect.stringMatching(/^\[Shared\] m: applying 2\.0\.0 was cut off when the bot process ended; put back the previous version from .+\. This machine applies the database's current version of m again at this start\.$/),
    ]);
    await rig.pass();
    expect(rig.entry('m')).toMatchObject({ sha: u });
    expect(rig.live('m')).toEqual(U_FILES);
  });
});
