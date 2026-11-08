import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 code review round 1, lane F, the boot rows (out/NB6/review1-F.md findings 1, 2 and 4): an apply whose recovery
// throws stays unloaded until the next boot; a throw in the boot compile's copies or record writes, or in the boot
// rule's write, leaves that module out and the boot goes on; the load check's error is the loader's own. Run through
// clientInitializer.ts's boot steps in runBot's order with part 18's boot rig.

const h = vi.hoisted(() => ({ manifests: (() => []) as () => string[], failStoreWrites: 0, failHoldWrite: false }));

vi.mock('dotenv/config', () => ({}));
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string | Buffer, keep?: { mode: number; uid: number; gid: number }) => {
      if (String(file).endsWith('.shared-mirror.json') && String(file).includes('appstore')) {
        if (h.failHoldWrite && JSON.parse(String(contents)).modules?.m?.heldSha) {
          throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
        }
        if (h.failStoreWrites > 0) {
          h.failStoreWrites -= 1;
          throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
        }
      }
      return real.atomicWriteFileSync(file, contents, keep);
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({ ...(await orig<any>()), findModuleManifests: () => h.manifests() }));

import fs from 'fs';
import path from 'path';
import { bootRig } from '../helpers/nb6BootRig';
import { noFile, ownError, reloaderFakes } from '../helpers/nb6FakeLoader';
import { _resetModuleCrashes, closeWindow, countCrash, openWindow, startModule } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';

const rig = bootRig();
const BUILD_FILE = () => path.join(rig.apply.state.root, 'dist', '.build-complete');
const shared = () => rig.apply.state.lines.filter(l => l.startsWith('[Shared]'));

beforeEach(async () => {
  await rig.setup();
  h.manifests = rig.manifests;
  h.failStoreWrites = 0;
  h.failHoldWrite = false;
});
afterEach(async () => {
  vi.useRealTimers();
  setStoppedServingHook(null);
  h.failStoreWrites = 0;
  h.failHoldWrite = false;
  await rig.teardown();
});

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

describe('finding 1: the recovery of a cut-off apply throws', () => {
  it("T33 with its tail; another module's stale build does not load the half-applied version; the entry keeps applying and the backup stays", async () => {
    const s = await rig.inPlace('m', '1.0.0');
    await rig.inPlace('n', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.fakeLoader.duringLoad = () => { setStoppedServingHook(() => true); };
    expect(await rig.apply.apply('m', u, { version: '2.0.0' })).toMatchObject({ outcome: 'deferred', reason: 'stopped-serving' });
    setStoppedServingHook(null);
    rig.fakeLoader.duringLoad = null;
    const backup = rig.apply.entry('m')!.applying!.backup!;
    fs.writeFileSync(BUILD_FILE(), 'image-2');
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(String(to)).includes('-interrupted')) throw Object.assign(new Error('EPERM: injected, rename'), { code: 'EPERM' });
      return real(from, to);
    });
    await expect(rig.boot()).resolves.toBeUndefined();
    expect(rig.loaded()).toEqual(['n@1.0.0']);
    expect(rig.apply.state.lines).toContain('[Error] m: finishing its start failed (EPERM: injected, rename); the bot finishes it at its next start, and until then this machine applies no change of m');
    await rig.turns();
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: null, applying: { from: s, to: u } });
    expect(fs.existsSync(backup)).toBe(true);
  });
});

describe('finding 2: a throw in the boot compile or the boot rule leaves that module out; the boot goes on', () => {
  it("the copy into the build folder throws ENOSPC: T2's boot form, built null, dist deleted, not loaded; the other module loads", async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.inPlace('n', '1.0.0');
    fs.writeFileSync(BUILD_FILE(), 'image-2');
    const real = fs.cpSync;
    vi.spyOn(fs, 'cpSync').mockImplementation(((from: any, to: any, opts: any) => {
      if (path.resolve(String(to)) === path.resolve(rig.apply.state.build, 'm')) throw Object.assign(new Error('ENOSPC: injected, copyfile'), { code: 'ENOSPC' });
      return real(from, to, opts);
    }) as typeof fs.cpSync);
    await expect(rig.boot()).resolves.toBeUndefined();
    expect(shared()).toContain('[Shared] m 1.0.0 could not be compiled on this machine at this start (ENOSPC: injected, copyfile); this machine does not load it, and compiles it again at the next start');
    expect(rig.apply.entry('m')).toMatchObject({ built: null });
    expect(rig.apply.dist('m')).toBeNull();
    expect(rig.loaded()).toEqual(['n@1.0.0']);
  });

  it("the copy of a version the boot swapped in throws: T2's retry path, the previous version back and loaded", async () => {
    const s = await rig.inPlace('m', '1.0.0');
    await rig.publish('m', '2.0.0');
    const real = fs.cpSync;
    let copies = 0;
    let refused = 0;
    vi.spyOn(fs, 'cpSync').mockImplementation(((from: any, to: any, opts: any) => {
      // The first copy is the swap's (43 step 3); the second is the boot compile's.
      if (path.resolve(String(to)) === path.resolve(rig.apply.state.build, 'm') && ++copies === 2) {
        refused += 1;
        throw Object.assign(new Error('ENOSPC: injected, copyfile'), { code: 'ENOSPC' });
      }
      return real(from, to, opts);
    }) as typeof fs.cpSync);
    await expect(rig.boot()).resolves.toBeUndefined();
    expect(refused).toBe(1);
    expect(shared().filter(l => l.includes('could not be compiled'))).toEqual([
      expect.stringMatching(/^\[Shared\] m 2\.0\.0 could not be compiled on this machine \(ENOSPC: injected, copyfile\); this machine keeps the previous version and tries again after \S+$/),
    ]);
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: null, applying: null });
    expect(rig.apply.entry('m')?.retryAt).toEqual(expect.any(Number));
    expect(rig.loaded()).toEqual(['m@1.0.0']);
  });

  it.each([
    ['setBuilt (a clean compile)', null],
    ["doesNotCompile (T19's errors)", ownError('m')],
    ["notCompiledAtBoot (69's compile naming no file)", noFile()],
  ])('the record write of %s throws: T33, dist deleted, m not loaded, no reject', async (_what, result) => {
    await rig.inPlace('m', '1.0.0');
    fs.writeFileSync(BUILD_FILE(), 'image-2');
    if (result) rig.compiles.results = [result];
    const inner = reloaderFakes.recompileTypeScript;
    reloaderFakes.recompileTypeScript = async opts => {
      const out = await inner(opts);
      h.failStoreWrites = 1;
      return out;
    };
    await expect(rig.boot()).resolves.toBeUndefined();
    expect(rig.apply.state.lines).toContain('[Error] m: finishing its start failed (ENOSPC: no space left on device, write)');
    expect(rig.apply.dist('m')).toBeNull();
    expect(rig.loaded()).toEqual([]);
  });

  it("the boot rule's write throws: T33, the version that stopped the bot twice is not loaded, no reject", async () => {
    const s = await rig.inPlace('m', '1.0.0');
    crashTwice('m', s, '1.0.0');
    h.failHoldWrite = true;
    await expect(rig.boot()).resolves.toBeUndefined();
    expect(rig.apply.state.lines).toContain('[Error] m: finishing its start failed (ENOSPC: no space left on device, write)');
    expect(rig.apply.entry('m')?.heldSha ?? null).toBeNull();
    expect(rig.loaded()).toEqual([]);
  });
});

describe("finding 4: the load check's error is the loader's", () => {
  it("a boot apply whose index.js throws: T1 and the failed status carry the thrown error", async () => {
    await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.code.set('m@2.0.0', { loadThrows: new Error("Cannot find module 'x'") });
    await rig.boot();
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: "Cannot find module 'x'" })]);
    expect(shared().some(l => l.includes("failed to load on this machine (Cannot find module 'x'); this machine keeps the previous version"))).toBe(true);
  });
});

describe("code review round 2: the apply's swap throws, the recovery's store lock throws", () => {
  it("R2-E1: the boot pass's swap throws after the intent write: the previous version is put back and loaded, the new one is not recorded applied", async () => {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    const real = fs.cpSync;
    let refused = 0;
    vi.spyOn(fs, 'cpSync').mockImplementation(((from: any, to: any, opts: any) => {
      if (refused === 0 && path.resolve(String(to)) === path.resolve(rig.apply.state.build, 'm')) {
        refused += 1;
        throw Object.assign(new Error('ENOSPC: injected, copyfile'), { code: 'ENOSPC' });
      }
      return real(from, to, opts);
    }) as typeof fs.cpSync);
    await expect(rig.boot()).resolves.toBeUndefined();
    await rig.turns();
    expect(refused).toBe(1);
    const retryAt = rig.apply.entry('m')?.retryAt;
    expect(typeof retryAt).toBe('number');
    expect(shared()).toContain(`[Shared] Could not bring the module m up to date (ENOSPC: injected, copyfile); this machine tries again after ${new Date(retryAt as number).toISOString()}`);
    expect(rig.loaded()).toEqual(['m@1.0.0']);
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, applying: null });
    expect(rig.apply.status('m').filter(st => st.sha === u && st.state === 'applied')).toEqual([]);
  });

  /** The first take of the store lock cannot create its file. */
  function lockOpenFailsOnce(): void {
    const real = fs.openSync;
    let failed = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (!failed && path.basename(String(p)) === '.store.lock') {
        failed = true;
        throw Object.assign(new Error('EACCES: injected, open'), { code: 'EACCES' });
      }
      return (real as any)(p, ...rest);
    }) as typeof fs.openSync);
  }

  it('R2-F2: the recovery cannot take the store lock: logged with the unfinished module, which is not loaded; the boot goes on', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    await rig.inPlace('n', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.fakeLoader.duringLoad = () => { setStoppedServingHook(() => true); };
    expect(await rig.apply.apply('m', u, { version: '2.0.0' })).toMatchObject({ outcome: 'deferred', reason: 'stopped-serving' });
    setStoppedServingHook(null);
    rig.fakeLoader.duringLoad = null;
    lockOpenFailsOnce();
    await expect(rig.boot()).resolves.toBeUndefined();
    expect(shared()).toContain('[Shared] Did not recover the module applies: EACCES: injected, open; the modules with an unfinished update (m) are not loaded at this start');
    expect(rig.loaded()).toEqual(['n@1.0.0']);
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, applying: { from: s, to: u } });
  });

  it('R2-F2: the same with no unfinished update: the line names none and every module loads', async () => {
    await rig.inPlace('m', '1.0.0');
    lockOpenFailsOnce();
    await expect(rig.boot()).resolves.toBeUndefined();
    expect(shared()).toContain('[Shared] Did not recover the module applies: EACCES: injected, open');
    expect(rig.loaded()).toEqual(['m@1.0.0']);
  });
});
