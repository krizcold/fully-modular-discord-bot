import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 8's boot rows of part 18 (wip-redesign/sheets/NB6.md decisions 45, 46, 59, 67, 69, 78, 81, 92, 105; rows 66,
// 115, 140, 141, 210 to 212, 265, 308 and 309) and test 10's row 340, run through clientInitializer.ts's boot steps in
// runBot's order (the recovery, bootShared with the pass's module step, the boot compile, loadModules with the real
// ModuleLoader and its load check, the initializer turns) over the rows the real publish writes and the entries the
// real apply writes. The compile is scripted (it emits the build tree into the dist tree, as tsc does with or without
// errors); the loader reads the dist tree's manifests; each module's code is a fake whose load may throw.

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
import { noFile, ownError } from '../helpers/nb6FakeLoader';
import { dataPath } from '../../src/utils/dataRoot';
import { BOOT_COMPILE_MS } from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetModuleCrashes, closeWindow, countCrash, openWindow, startModule } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { getHeldBack, getLoadFailures } from '../../src/bot/internalSetup/utils/loadFailures';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';

const rig = bootRig();
const SAFE_MODE = () => dataPath('build-safe-mode.json');
const BUILD_FILE = () => path.join(rig.apply.state.root, 'dist', '.build-complete');
const shared = () => rig.apply.state.lines.filter(l => l.startsWith('[Shared]'));

beforeEach(async () => {
  await rig.setup();
  h.manifests = rig.manifests;
});
afterEach(async () => {
  vi.useRealTimers();
  fs.rmSync(SAFE_MODE(), { force: true });
  await rig.teardown();
});

/** The version in place stopped the bot twice while it started, counted as guardUncaught counts it in two processes. */
function crashTwice(module: string, sha: string, version: string): void {
  for (let i = 0; i < 2; i += 1) {
    _resetModuleCrashes();
    const start = startModule(module, sha, version, path.join(rig.apply.state.dist, module), { boot: true });
    if (typeof start === 'string') throw new Error(start);
    openWindow(start);
    countCrash(new Error(`crash ${i + 1}`));
    closeWindow(start);
  }
  _resetModuleCrashes();
}

describe('rows 66 and 140: a row published while the bot was down', () => {
  it('the boot swaps it in before the modules load, loads it, and its start writes the entry and the status at its turn', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.fakeLoader.loads = [];
    await rig.boot();
    expect(rig.fakeLoader.loads).toEqual([]);
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    expect(rig.apply.live('m')).toEqual(moduleFiles('m', '2.0.0'));
    expect(rig.apply.entry('m')?.applying).toMatchObject({ from: s, to: u });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: s })]);
    await rig.turns();
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, built: { sha: u, buildId: null }, failedSha: null, applying: null });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: u })]);
    expect(rig.apply.backupsOf('m')).toEqual([]);
  });
});

describe('row 115: the compile runs for every module the boot swapped or an interrupted apply left', () => {
  it('one compile with the 600 s bound for a swap; none when every entry is built for this build', async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.boot();
    expect(rig.compiles.calls).toEqual([]);
    await rig.turns();
    await rig.publish('m', '2.0.0');
    await rig.boot();
    expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS]);
    expect(BOOT_COMPILE_MS).toBe(600_000);
  });

  it('an apply cut off during its load: the recovery puts the previous version back (built null), and the boot compiles and applies the row again', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    // The process stops serving its shards during the load (C16): the entry keeps the intent, as when it ends there.
    rig.fakeLoader.duringLoad = () => { setStoppedServingHook(() => true); };
    expect(await rig.apply.apply('m', u, { version: '2.0.0' })).toMatchObject({ outcome: 'deferred', reason: 'stopped-serving' });
    setStoppedServingHook(null);
    expect(rig.apply.entry('m')?.applying).toMatchObject({ from: s, to: u });
    rig.fakeLoader.duringLoad = null;
    await rig.boot();
    expect(shared().some(l => l.startsWith('[Shared] m: applying 2.0.0 was cut off when the bot process ended; put back the previous version from'))).toBe(true);
    expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS]);
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    await rig.turns();
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null });
  });
});

describe("row 141: a module applied at boot fails to load (45 (6)'s f)", () => {
  it('unregistered, put back, compiled, the previous version loaded in its place; failedSha, T1 and a failed status', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.code.set('m@2.0.0', { loadThrows: new Error('index.js threw: boom') });
    await rig.boot();
    expect(rig.loaded()).toEqual(['m@1.0.0']);
    expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS, BOOT_COMPILE_MS]);
    expect(rig.apply.live('m')).toEqual(moduleFiles('m', '1.0.0'));
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: u, built: { sha: s, buildId: null }, applying: null });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: 'index.js threw: boom' })]);
    expect(shared().some(l => /^\[Shared\] m 2\.0\.0 from .+ failed to load on this machine \(index\.js threw: boom\); this machine keeps the previous version and does not try 2\.0\.0 again until m is updated, or uninstalled and installed again$/.test(l))).toBe(true);
    expect(rig.apply.backupsOf('m').some(n => n.endsWith('-failed'))).toBe(true);
    await rig.turns();
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: u });
  });
});

describe("test 10's row 340: f with the restored version held", () => {
  it('not loaded, recorded held back, not in loadedModules; T1 held form and T24 boot form', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    crashTwice('m', s, '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.code.set('m@2.0.0', { loadThrows: new Error('index.js threw: boom') });
    await rig.boot();
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, heldSha: s, failedSha: u, applying: null });
    expect(rig.loaded()).toEqual([]);
    expect(getHeldBack()).toEqual(['m']);
    const lines = rig.apply.state.lines;
    expect(lines).toContain('[ModuleLoader] m 1.0.0 was not loaded: this machine holds it back after the bot stopped twice while it was starting it (see the App Store tab)');
    expect(lines.some(l => /^\[Shared\] m 2\.0\.0 from .+ failed to load on this machine \(index\.js threw: boom\); this machine does not try 2\.0\.0 again until m is updated, or uninstalled and installed again\. It keeps the previous version on disk but does not load it: that version is held back after the bot stopped twice while it was starting it$/.test(l))).toBe(true);
  });
});

describe('rows 210 and 211: a new image build and the safe-mode marker', () => {
  it('210: .build-complete differs from built.buildId: every module copied into build, one compile, built rewritten', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    fs.rmSync(path.join(rig.apply.state.build, 'm'), { recursive: true, force: true });
    fs.rmSync(path.join(rig.apply.state.dist, 'm'), { recursive: true, force: true });
    fs.writeFileSync(BUILD_FILE(), 'image-2');
    await rig.boot();
    expect(rig.apply.built('m')).toEqual(moduleFiles('m', '1.0.0'));
    expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS]);
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, built: { sha: s, buildId: 'image-2' } });
    expect(rig.loaded()).toEqual(['m@1.0.0']);
    await rig.boot();
    expect(rig.compiles.calls).toEqual([]);
  });

  it('211: the marker present: the same at every boot while it is present; the modules load', async () => {
    await rig.inPlace('m', '1.0.0');
    fs.writeFileSync(SAFE_MODE(), '{}');
    for (let i = 0; i < 2; i += 1) {
      fs.rmSync(path.join(rig.apply.state.build, 'm'), { recursive: true, force: true });
      fs.rmSync(path.join(rig.apply.state.dist, 'm'), { recursive: true, force: true });
      await rig.boot();
      expect(rig.compiles.calls).toEqual([BOOT_COMPILE_MS]);
      expect(rig.apply.built('m')).toEqual(moduleFiles('m', '1.0.0'));
      expect(rig.loaded()).toEqual(['m@1.0.0']);
    }
  });
});

describe('row 212: after a new build, a module not applied this boot no longer compiles', () => {
  it('its build and dist folders deleted; not loaded; built null; a failed status; T19', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    fs.writeFileSync(BUILD_FILE(), 'image-2');
    rig.compiles.results = [ownError('m')];
    await rig.boot();
    expect(rig.apply.built('m')).toBeNull();
    expect(rig.apply.dist('m')).toBeNull();
    expect(rig.apply.live('m')).toEqual(moduleFiles('m', '1.0.0'));
    expect(rig.loaded()).toEqual([]);
    const error = "build/bot/modules/m/index.ts:3 Type 'string' is not assignable to type 'number'.; 1 errors in its files";
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, built: null });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: s, error })]);
    expect(shared()).toContain(`[Shared] m 1.0.0 does not compile with this bot's version (${error}); this machine does not load it until it is updated or the bot's version changes`);
  });
});

describe('row 265: the compile after a safe-mode build fails naming no file', () => {
  it("every module that failed builtCurrent: dist deleted, built null, a failed status, T2's boot form; an applied one by the T2 path", async () => {
    await rig.inPlace('a', '1.0.0');
    const b1 = await rig.inPlace('b', '1.0.0');
    const b2 = await rig.publish('b', '2.0.0');
    fs.writeFileSync(SAFE_MODE(), '{}');
    rig.compiles.results = [noFile(), noFile()];
    await rig.boot();
    const error = 'Command failed: tsc (killed)';
    expect(shared()).toContain(`[Shared] The boot compile of App Store modules failed (${error})`);
    expect(rig.apply.dist('a')).toBeNull();
    expect(rig.apply.built('a')).toEqual(moduleFiles('a', '1.0.0'));
    expect(rig.apply.entry('a')).toMatchObject({ built: null, retryAt: null });
    expect(rig.apply.status('a')).toEqual([expect.objectContaining({ state: 'failed', error })]);
    expect(shared()).toContain(`[Shared] a 1.0.0 could not be compiled on this machine at this start (${error}); this machine does not load it, and compiles it again at the next start`);
    expect(rig.apply.entry('b')).toMatchObject({ sha: b1, failedSha: null, applying: null });
    expect(rig.apply.entry('b')?.retryAt).toBeGreaterThan(Date.now());
    expect(rig.apply.status('b')).toEqual([expect.objectContaining({ state: 'failed', sha: b2 })]);
    expect(shared().some(l => l.startsWith(`[Shared] b 2.0.0 could not be compiled on this machine (${error}); this machine keeps the previous version and tries again after `))).toBe(true);
    expect(rig.loaded()).toEqual([]);
  });
});

describe('rows 308 and 309: the boot compile bound (81)', () => {
  it('308: a compile that runs past 60 s and ends before 600 s: compiled, the module loads; it was given 600000 ms', async () => {
    await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rig.compiles.delayMs = 90_000;
    const booted = rig.boot();
    await vi.advanceTimersByTimeAsync(90_001);
    await booted;
    expect(rig.compiles.calls).toEqual([600_000]);
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    expect(rig.apply.entry('m')?.applying).toMatchObject({ to: u });
    expect(shared().filter(l => l.includes('could not be compiled'))).toEqual([]);
  });

  it("309: a compile still running at 600 s takes 69's path with \"it did not finish within 10 minutes\" and T2's boot form", async () => {
    await rig.inPlace('m', '1.0.0');
    fs.writeFileSync(BUILD_FILE(), 'image-2');
    fs.rmSync(path.join(rig.apply.state.dist, 'm'), { recursive: true, force: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rig.compiles.never = true;
    const booted = rig.boot();
    await vi.advanceTimersByTimeAsync(600_001);
    await booted;
    expect(shared()).toContain('[Shared] The boot compile of App Store modules failed (it did not finish within 10 minutes)');
    expect(shared()).toContain('[Shared] m 1.0.0 could not be compiled on this machine at this start (it did not finish within 10 minutes); this machine does not load it, and compiles it again at the next start');
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'failed', error: 'it did not finish within 10 minutes' })]);
    expect(rig.loaded()).toEqual([]);
    expect(getLoadFailures()).toEqual([]);
  });
});

describe("test 46's row 301: the restart after a boot whose clientReady handler returned early", () => {
  it("45 (1) recovers 'interrupted' (the backup put back), T4 with \"when the bot process ended\" and \"applies again\"; 45 (3) applies again", async () => {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    await rig.boot();
    const backup = rig.apply.entry('m')!.applying!.backup!;
    expect(rig.apply.entry('m')?.applying).toMatchObject({ from: s, to: u });
    rig.apply.state.lines.length = 0;
    await rig.boot();
    expect(shared()).toContain(`[Shared] m: applying 2.0.0 was cut off when the bot process ended; put back the previous version from ${backup}. This machine applies the database's current version of m again at this start.`);
    expect(rig.apply.entry('m')?.applying).toMatchObject({ from: s, to: u });
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    await rig.turns();
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null, failedSha: null });
  });
});

describe("a restoreModule throw at boot (decision 102's rule, rows 354 and 359): caught per module", () => {
  const T33 = "[Error] m: finishing its start failed (EPERM: injected, rename); the bot finishes it at its next start, and until then this machine applies no change of m";

  /** fs.renameSync refuses the live folder's move to its '-failed' backup, as restoreModule's step b makes it. */
  function refuseFailedRename(): { refused: number } {
    const refused = { refused: 0 };
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(String(to)).includes('-failed')) {
        refused.refused += 1;
        throw Object.assign(new Error('EPERM: injected, rename'), { code: 'EPERM' });
      }
      return real(from, to);
    });
    return refused;
  }

  it.each([
    ['the boot compile (own-file errors)', () => { rig.compiles.results = [ownError('m')]; }],
    ['the load check (a failed load)', () => { rig.code.set('m@2.0.0', { loadThrows: new Error('index.js threw: boom') }); }],
  ])('in %s: T33 with its tail, no reject, nothing more written, m not loaded; the next boot recovers the entry', async (_where, arrange) => {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    arrange();
    const refused = refuseFailedRename();
    await expect(rig.boot()).resolves.toBeUndefined();
    expect(refused.refused).toBe(1);
    expect(rig.apply.state.lines).toContain(T33);
    expect(rig.apply.entry('m')?.applying).toMatchObject({ from: s, to: u });
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: null });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: s })]);
    expect(rig.loaded()).toEqual([]);
    await rig.turns();
    expect(rig.apply.entry('m')?.applying).toMatchObject({ from: s, to: u });

    vi.mocked(fs.renameSync).mockRestore();
    rig.code.clear();
    rig.apply.state.lines.length = 0;
    await rig.boot();
    expect(shared().some(l => l.startsWith('[Shared] m: applying 2.0.0 was cut off when the bot process ended;'))).toBe(true);
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    await rig.turns();
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null, failedSha: null });
  });
});
