import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB23 (sheets/NB6.md:2952-2954): a module whose own files do not compile with the bot's version (T19) is not compiled
// again at every boot. The entry records the sha and image build it failed on; a later boot of the same build and sha
// runs no compile for it, logs T19 again and leaves it unloaded; a new build, a safe-mode build or a new version
// compiles it again. Run through clientInitializer.ts's boot steps with nb6BootRig.

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
import { dataPath } from '../../src/utils/dataRoot';
import { BOOT_COMPILE_MS } from '../../src/bot/internalSetup/utils/moduleApply';

const rig = bootRig();
const SAFE_MODE = () => dataPath('build-safe-mode.json');
const BUILD_FILE = () => path.join(rig.apply.state.root, 'dist', '.build-complete');
const shared = () => rig.apply.state.lines.filter(l => l.startsWith('[Shared]'));
const ERROR = "build/bot/modules/m/index.ts:3 Type 'string' is not assignable to type 'number'.; 1 errors in its files";
const T19 = `[Shared] m 1.0.0 does not compile with this bot's version (${ERROR}); this machine does not load it until it is updated or the bot's version changes`;

beforeEach(async () => {
  await rig.setup();
  h.manifests = rig.manifests;
});
afterEach(async () => {
  fs.rmSync(SAFE_MODE(), { force: true });
  await rig.teardown();
});

/** m 1.0.0 in place, then a boot on a new build where its own files fail: T19. */
async function failsOnNewBuild(): Promise<string> {
  const s = await rig.inPlace('m', '1.0.0');
  fs.writeFileSync(BUILD_FILE(), 'image-2');
  rig.compiles.results = [ownError('m')];
  await rig.boot();
  expect(shared()).toContain(T19);
  rig.apply.state.lines.length = 0;
  return s;
}

describe('T19 is recorded with the build it failed on', () => {
  it('the entry names the sha, the build and the error', async () => {
    const s = await failsOnNewBuild();
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, built: null, noCompile: { sha: s, buildId: 'image-2', error: ERROR } });
  });

  it('the next boot of the same build runs no compile, logs T19 again and does not load the module', async () => {
    await failsOnNewBuild();
    await rig.boot();
    expect(rig.compiles.calls).toEqual([]);
    expect(shared()).toContain(T19);
    expect(rig.apply.dist('m')).toBeNull();
    expect(rig.loaded()).toEqual([]);
  });

  it('a compile run for another module judges it again: still failing, T19 and no load', async () => {
    await failsOnNewBuild();
    await rig.publish('n', '1.0.0');
    rig.compiles.results = [ownError('m')];
    await rig.boot();
    expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS]);
    expect(shared()).toContain(T19);
    expect(rig.apply.dist('m')).toBeNull();
    expect(rig.loaded()).toEqual(['n@1.0.0']);
  });

  it('a new build compiles it again, and once it compiles it loads and the record is cleared', async () => {
    const s = await failsOnNewBuild();
    fs.writeFileSync(BUILD_FILE(), 'image-3');
    await rig.boot();
    expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS]);
    expect(rig.loaded()).toEqual(['m@1.0.0']);
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, built: { sha: s, buildId: 'image-3' }, noCompile: null });
  });

  it('a safe-mode build compiles it again', async () => {
    await failsOnNewBuild();
    fs.writeFileSync(SAFE_MODE(), '{}');
    rig.compiles.results = [ownError('m')];
    await rig.boot();
    expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS]);
    expect(shared()).toContain(T19);
  });

  it('a T19 during safe mode is not remembered: the next boot compiles and loads it', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    fs.writeFileSync(BUILD_FILE(), 'image-2');
    fs.writeFileSync(SAFE_MODE(), '{}');
    rig.compiles.results = [ownError('m')];
    await rig.boot();
    expect(shared()).toContain(T19);
    expect(rig.apply.entry('m')).toMatchObject({ built: null, noCompile: null });
    fs.rmSync(SAFE_MODE(), { force: true });
    rig.compiles.calls.length = 0;
    await rig.boot();
    expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS]);
    expect(rig.loaded()).toEqual(['m@1.0.0']);
    expect(rig.apply.entry('m')).toMatchObject({ built: { sha: s, buildId: 'image-2' }, noCompile: null });
  });

  it('a new version is applied and compiled as any update', async () => {
    await failsOnNewBuild();
    const u = await rig.publish('m', '2.0.0');
    await rig.boot();
    expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS]);
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    expect(rig.apply.live('m')).toEqual(moduleFiles('m', '2.0.0'));
    expect(rig.apply.entry('m')?.applying).toMatchObject({ to: u });
  });
});
