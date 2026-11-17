import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The boot compile's T19 path (NB23): a T19 recorded for another sha does not stop the compile; a boot that runs no
// compile clears the module's compiled folders, and a clear that throws leaves the module out of the load.

const h = vi.hoisted(() => ({ manifests: (() => []) as () => string[] }));

vi.mock('dotenv/config', () => ({}));
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({ ...(await orig<any>()), findModuleManifests: () => h.manifests() }));

import fs from 'fs';
import path from 'path';
import { bootRig, moduleFiles } from '../helpers/nb6BootRig';
import { ownError } from '../helpers/nb6FakeLoader';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { BOOT_COMPILE_MS } from '../../src/bot/internalSetup/utils/moduleApply';

const rig = bootRig();
const BUILD_FILE = () => path.join(rig.apply.state.root, 'dist', '.build-complete');
const ERROR = "build/bot/modules/m/index.ts:3 Type 'string' is not assignable to type 'number'.; 1 errors in its files";
const T19 = `[Shared] m 1.0.0 does not compile with this bot's version (${ERROR}); this machine does not load it until it is updated or the bot's version changes`;
const shared = () => rig.apply.state.lines.filter(l => l.startsWith('[Shared]') || l.startsWith('[Error]'));

beforeEach(async () => {
  await rig.setup();
  h.manifests = rig.manifests;
});
afterEach(async () => {
  await rig.teardown();
});

/** m 1.0.0 in place, then a boot on a new build where its own files fail: T19 recorded. */
async function failsOnNewBuild(): Promise<string> {
  const s = await rig.inPlace('m', '1.0.0');
  fs.writeFileSync(BUILD_FILE(), 'image-2');
  rig.compiles.results = [ownError('m')];
  await rig.boot();
  expect(shared()).toContain(T19);
  rig.apply.state.lines.length = 0;
  return s;
}

/** A dist folder of m left in place, as a compile of another image left it. */
function leftDist(): string {
  const dir = path.join(rig.apply.state.dist, 'm');
  rig.apply.writeTree(dir, moduleFiles('m', '1.0.0'));
  return dir;
}

describe('a T19 recorded for another sha', () => {
  it('does not stop the compile of the sha in place, which then loads', async () => {
    const s = await failsOnNewBuild();
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    read.record.modules.m = { ...read.record.modules.m, noCompile: { sha: `${s}-earlier`, buildId: 'image-2', error: ERROR } };
    writeStoreRecord(read.record);
    await rig.boot();
    expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS]);
    expect(rig.loaded()).toEqual(['m@1.0.0']);
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, built: { sha: s, buildId: 'image-2' }, noCompile: null });
  });
});

describe('a boot that runs no compile for a T19 module', () => {
  it("removes the module's dist folder left in place, so the module is not loaded", async () => {
    await failsOnNewBuild();
    leftDist();
    await rig.boot();
    expect(rig.compiles.calls).toEqual([]);
    expect(shared()).toContain(T19);
    expect(rig.apply.dist('m')).toBeNull();
    expect(rig.loaded()).toEqual([]);
  });

  it('a clear that throws is logged and leaves the module out of the load', async () => {
    await failsOnNewBuild();
    const dist = leftDist();
    const realRm = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
      if (path.resolve(String(target)) === path.resolve(dist)) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${dist}'`), { code: 'EBUSY' });
      return realRm(target, options);
    }) as typeof fs.rmSync);
    await rig.boot();
    expect(rig.compiles.calls).toEqual([]);
    expect(shared()).toContain(`[Error] m: finishing its start failed (EBUSY: resource busy or locked, rmdir '${dist}')`);
    expect(shared()).not.toContain(T19);
    expect(rig.loaded()).toEqual([]);
  });
});
