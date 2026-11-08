import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 64 (wip-redesign/sheets/NB6.md decisions 60, 67, 78, 89, 91, 93, 99, 101, 104 to 106, 109), part 16's rows
// by E6: the live load and reload rows that pass with the real reloader and the real apply. `loadModuleUnmarked`,
// `reloadModule` and `reloadModules` over fake modules (ModuleLoader.loadModule answers a module whose command
// initializers return promises the row controls), tsc's exec answered at once, fake timers for the 60 s and 10 minute
// bounds. Entries from the real apply, crash lines from the real count. Rows 326 to 329, 337, 338, 354 to 355 (the
// reload half), 357, 360, 362 to 366, 375 (the reload half), 385, 386, 390 and 391 (the reload half), and test 60's
// row 307; part 17 adds rows 335 and 336 (a reload of a held version). The boot-turn rows and 376's IPC half are part
// 18's.

const h = vi.hoisted(() => ({
  manifests: [] as string[],
  /** Per module name and version: what the fake module's code does. */
  code: new Map<string, { initialize?: () => unknown; loadThrows?: Error; onLoad?: () => unknown }>(),
  slashThrows: null as Error | null,
  /** The next slash command registration throws this, once. */
  slashThrowsOnce: null as Error | null,
  unloadThrows: null as Error | null,
  lookups: 0,
  throwOnLookup: 0,
  /** A folder whose deletion is refused with EBUSY. */
  rmRefused: null as string | null,
  /** The next store record write with applying cleared throws before it lands. */
  failFinishWrite: false,
}));

vi.mock('fs', async orig => {
  const real = await orig<typeof import('fs')>();
  const rmSync = ((target: import('fs').PathLike, options?: import('fs').RmOptions) => {
    if (h.rmRefused && String(target) === h.rmRefused) throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' });
    return real.rmSync(target, options);
  }) as typeof real.rmSync;
  return { ...real, rmSync, default: { ...real, rmSync } };
});
vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string | Buffer, keep?: { mode: number; uid: number; gid: number }) => {
      if (h.failFinishWrite && String(file).endsWith('.shared-mirror.json') && String(file).includes('appstore') && !JSON.parse(String(contents)).modules.m?.applying) {
        h.failFinishWrite = false;
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      real.atomicWriteFileSync(file, contents, keep);
    },
  };
});

vi.mock('child_process', async orig => {
  const real = await orig<typeof import('child_process')>();
  return { ...real, exec: (_command: string, _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => callback(null, '', '') };
});
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({
  ...(await orig<any>()),
  getBuildRoot: () => 'Z:/nb6-no-build-root',
  findModuleManifests: () => {
    h.lookups += 1;
    if (h.lookups === h.throwOnLookup) throw new Error('EACCES: permission denied, scandir');
    return h.manifests;
  },
}));
vi.mock('../../src/bot/internalSetup/utils/commandUtils', async orig => ({
  ...(await orig<any>()),
  reRegisterSlashCommands: async () => {
    if (h.slashThrowsOnce) {
      const once = h.slashThrowsOnce;
      h.slashThrowsOnce = null;
      throw once;
    }
    if (h.slashThrows) throw h.slashThrows;
  },
}));
vi.mock('../../src/bot/internalSetup/utils/ipcToggleHandler', async orig => ({ ...(await orig<any>()), applyComponentToggleState: async () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/settings/settingsDiscovery', async orig => ({ ...(await orig<any>()), getModulesWithSettings: () => [] }));

import fs from 'fs';
import path from 'path';
import type { Client } from 'discord.js';
import fc from 'fast-check';
import { applyRig } from '../helpers/nb6ApplyRig';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { ModuleRegistry, getModuleRegistry, resetModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { isReloading, loadModuleUnmarked, reloadModule, reloadModules } from '../../src/bot/internalSetup/utils/moduleReloader';
import {
  closeWindow, countCrash, endStart, lateStarts, markLate, onStartEnded, openStarts, openWindow, startEnds, starting, startModule, type ModuleStart,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { dataPath } from '../../src/utils/dataRoot';
import { storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';
import { clearLoadFailures, getHeldBack } from '../../src/bot/internalSetup/utils/loadFailures';
import { recoverModuleApplies } from '../../src/bot/internalSetup/utils/moduleApply';

const rig = applyRig();
const client = { options: { intents: 0 } } as unknown as Client;
const CRASH_FILE = dataPath('global', 'appstore', 'cache', 'module-crashes.json');

const manifestOf = (name: string, version: string) =>
  JSON.stringify({ name, version, displayName: name, description: 'a test module', author: 'a', category: 'misc' });
const files = (name: string, version: string) => ({ 'module.json': manifestOf(name, version), 'index.js': `exports.v = '${version}';\n` });

/** A module folder whose manifest the reloader finds (the runtime folder is the source folder here). */
function placed(name: string, version: string): string {
  const dir = path.join(rig.state.source, name);
  rig.writeTree(dir, files(name, version));
  const manifest = path.join(dir, 'module.json');
  if (!h.manifests.includes(manifest)) h.manifests.push(manifest);
  return dir;
}

function deferredPromise<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const crashLines = () => (fs.existsSync(CRASH_FILE) ? JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8')) : {});

beforeEach(async () => {
  await rig.setup();
  const { _setModuleDirs, setModuleApplyClient } = await import('../../src/bot/internalSetup/utils/moduleApply');
  _setModuleDirs({ source: rig.state.source, build: rig.state.build, dist: rig.state.dist, backups: rig.state.backups, buildFile: path.join(rig.state.root, 'dist', '.build-complete') });
  setModuleApplyClient(client);
  h.manifests = [];
  h.code.clear();
  h.slashThrows = null;
  h.slashThrowsOnce = null;
  h.unloadThrows = null;
  h.lookups = 0;
  h.throwOnLookup = 0;
  h.rmRefused = null;
  h.failFinishWrite = false;
  vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async (manifest: any, modulePath: string) => {
    const code = h.code.get(`${manifest.name}@${manifest.version}`) ?? {};
    if (code.loadThrows) throw code.loadThrows;
    return {
      manifest, path: modulePath, events: new Map(), panels: [], exports: new Map(), initialized: false, importedFiles: [],
      commands: code.initialize ? [{ name: `${manifest.name}-cmd`, initialize: code.initialize }] : [],
      hooks: code.onLoad ? { onLoad: code.onLoad } : undefined,
    } as any;
  });
  resetModuleRegistry();
  const unload = ModuleRegistry.prototype.unloadModule;
  vi.spyOn(ModuleRegistry.prototype, 'unloadModule').mockImplementation(async function (this: ModuleRegistry, name: string) {
    if (h.unloadThrows) throw h.unloadThrows;
    return unload.call(this, name);
  });
});

afterEach(async () => {
  vi.useRealTimers();
  h.unloadThrows = null;
  for (const name of getModuleRegistry().getAllModules().map(m => m.manifest.name)) await getModuleRegistry().unloadModule(name);
  await rig.teardown();
});

/** The version in place on this machine, published and applied by the real apply with the real reloader. */
async function inPlace(name: string, version: string): Promise<string> {
  placed(name, version);
  fs.rmSync(path.join(rig.state.source, name), { recursive: true, force: true });
  const sha = await rig.publish(name, files(name, version), version);
  const result = await rig.apply(name, sha, { version });
  if (result.outcome !== 'applied') throw new Error(JSON.stringify(result));
  return sha;
}

/** A crash of the module's sha counted while a window of it was open, as guardUncaught counts it. */
function counted(name: string, sha: string, version: string): void {
  const start = startModule(name, sha, version, path.join(rig.state.source, name));
  if (typeof start === 'string') throw new Error(start);
  openWindow(start);
  countCrash(new Error('it stopped the bot'));
  closeWindow(start);
  openStarts.delete(name);
}

describe('a live apply whose initializers pass 60 s (91, 89)', () => {
  async function lateApply(init: () => unknown) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await inPlace('m', '1.0.0');
    const u = await rig.publish('m', files('m', '2.0.0'), '2.0.0');
    counted('m', u, '2.0.0');
    h.code.set('m@2.0.0', { initialize: init });
    rig.state.lines.length = 0;
    const applying = rig.apply('m', u, { version: '2.0.0' });
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await applying;
    return { s, u, result };
  }

  it('326: T27 with the applying tail; the apply answers loaded; the entry keeps applying and the backup; the start is late; the line kept', async () => {
    const pending = deferredPromise();
    const { s, u, result } = await lateApply(() => pending.promise);
    expect(result).toEqual({ outcome: 'loaded', reason: null, error: null, loaded: true });
    expect(rig.state.lines).toContain("[Reloader] m's initializers did not finish within 60 s; the reload goes on and waits up to 10 minutes for them; this machine finishes applying 2.0.0 when they finish without an error, or at 10 minutes; an error makes it keep the previous version");
    const entry = rig.entry('m')!;
    expect(entry.applying).toMatchObject({ from: s, to: u });
    expect(fs.existsSync(entry.applying!.backup!)).toBe(true);
    expect(lateStarts().map(st => st.sha)).toEqual([u]);
    expect(starting.size).toBe(0);
    expect(crashLines().m).toMatchObject({ sha: u, n: 1 });
    expect(isReloading('m')).toBe(false);
    pending.resolve();
  });

  it("327: the promises settle with no rejection before 10 minutes: step 6's entry, the applied status, the backup deleted, the line deleted", async () => {
    const pending = deferredPromise();
    const { u } = await lateApply(() => pending.promise);
    const backup = rig.entry('m')!.applying!.backup!;
    pending.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(rig.entry('m')?.applying ?? null).toBeNull());
    expect(rig.entry('m')).toMatchObject({ sha: u, failedSha: null });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: u })]);
    expect(fs.existsSync(backup)).toBe(false);
    expect(crashLines().m).toBeUndefined();
    expect(openStarts.has('m')).toBe(false);
  });

  it("328: one of the late promises rejects: 67's failure path puts the previous version back, T1, a failed status", async () => {
    const pending = deferredPromise();
    const { s, u } = await lateApply(() => pending.promise);
    pending.reject(new Error('the initializer gave up'));
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(rig.entry('m')?.applying ?? null).toBeNull());
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: 'the initializer gave up' })]);
    expect(rig.state.lines).toContain('[Shared] m 2.0.0 from BRAVO failed to load on this machine (the initializer gave up); this machine keeps the previous version and does not try 2.0.0 again until m is updated, or uninstalled and installed again');
    expect(rig.live('m')).toEqual(files('m', '1.0.0'));
  });

  it("329: the promises still open at 10 minutes: T29 with the tag [Reloader], step 6, the line deleted", async () => {
    const { u } = await lateApply(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(rig.entry('m')?.applying ?? null).toBeNull());
    expect(rig.state.lines).toContain("[Reloader] m's initializers did not finish within 10 minutes; the bot counts m as started and keeps 2.0.0");
    expect(rig.entry('m')).toMatchObject({ sha: u });
    expect(crashLines().m).toBeUndefined();
  });

  it('357: a late end that throws after step 6\'s record write (the backup deletion refused): T33 without its tail, applying clear, the backup stays', async () => {
    const pending = deferredPromise();
    const { u } = await lateApply(() => pending.promise);
    const backup = rig.entry('m')!.applying!.backup!;
    h.rmRefused = backup;
    pending.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(rig.state.lines).toContain('[Error] m: finishing its start failed (EBUSY: resource busy or locked, rmdir)'));
    h.rmRefused = null;
    expect(rig.entry('m')).toMatchObject({ sha: u });
    expect(rig.entry('m')?.applying ?? null).toBeNull();
    expect(fs.existsSync(backup)).toBe(true);
    expect(startEnds.has('m')).toBe(false);
  });

  it('354 and 355 (the reload half): a late end that throws before step 6\'s write: T33 with its tail, applying kept, the mutex and the mark free; a reload is refused with T31 (e)', async () => {
    const pending = deferredPromise();
    await lateApply(() => pending.promise);
    const hold = await storeMutex.acquire();
    expect(hold).not.toBeNull();
    hold!.release();
    h.failFinishWrite = true;
    pending.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(startEnds.get('m')).toBe('failed'));
    expect(rig.state.lines.some(l => l.startsWith('[Error] m: finishing its start failed (') && l.endsWith('; the bot finishes it at its next start, and until then this machine applies no change of m'))).toBe(true);
    expect(rig.entry('m')?.applying).toBeTruthy();
    expect(isReloading('m')).toBe(false);
    const again = await storeMutex.acquire(10);
    expect(again).not.toBeNull();
    again!.release();
    vi.useRealTimers();
    const out = await reloadModule(client, 'm');
    expect(out).toMatchObject({ success: false, error: "m was not reloaded: finishing its last change failed on this machine (see the bot's log), and the bot finishes it at its next start. Restart the bot, then try again." });
  });

  it("352 and 353 (part 18): a late start ended { failed } by its success test; U applied again, late too; the first start's promises settling write nothing; the new start's rejection takes 67's failure path", async () => {
    const first = deferredPromise();
    const second = deferredPromise();
    const promises = [first.promise, second.promise];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await inPlace('m', '1.0.0');
    const u = await rig.publish('m', files('m', '2.0.0'), '2.0.0');
    h.code.set('m@2.0.0', { initialize: () => promises.shift() });
    h.slashThrowsOnce = new Error('Discord answered 429');
    const applying = rig.apply('m', u, { version: '2.0.0' });
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await applying;
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous' });
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u, applying: null });
    expect(openStarts.has('m')).toBe(false);

    counted('m', u, '2.0.0');
    const again = rig.apply('m', u, { version: '2.0.0' });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await again).toEqual({ outcome: 'loaded', reason: null, error: null, loaded: true });
    const backup = rig.entry('m')!.applying!.backup!;
    const lines = rig.state.lines.length;
    first.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(rig.entry('m')?.applying).toMatchObject({ from: s, to: u });
    expect(crashLines().m).toMatchObject({ sha: u, n: 1 });
    expect(fs.existsSync(backup)).toBe(true);
    expect(rig.state.lines.slice(lines)).toEqual([]);

    second.reject(new Error('the second start gave up'));
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(rig.entry('m')?.applying ?? null).toBeNull());
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: 'the second start gave up' })]);
    expect(rig.state.lines).toContain('[Shared] m 2.0.0 from BRAVO failed to load on this machine (the second start gave up); this machine keeps the previous version and does not try 2.0.0 again until m is updated, or uninstalled and installed again');
  });
});

describe("test 60's row 307: a live apply's start that ends within its turn", () => {
  it('deletes the line of to, and step 6 runs as before', async () => {
    await inPlace('m', '1.0.0');
    const u = await rig.publish('m', files('m', '2.0.0'), '2.0.0');
    counted('m', u, '2.0.0');
    h.code.set('m@2.0.0', { initialize: () => Promise.resolve() });
    const result = await rig.apply('m', u, { version: '2.0.0' });
    expect(result.outcome).toBe('applied');
    expect(crashLines().m).toBeUndefined();
    expect(rig.entry('m')).toMatchObject({ sha: u });
  });
});

describe("lane F finding 4: an initializer that rejects within its turn during a live apply", () => {
  it("the apply's error, T1 and the failed status carry the rejection's error", async () => {
    clearLoadFailures();
    await inPlace('m', '1.0.0');
    const u = await rig.publish('m', files('m', '2.0.0'), '2.0.0');
    h.code.set('m@2.0.0', { initialize: () => Promise.reject(new Error("Cannot find module 'x'")) });
    const result = await rig.apply('m', u, { version: '2.0.0' });
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous', error: "Cannot find module 'x'" });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: "Cannot find module 'x'" })]);
    expect(rig.state.lines).toContain("[Shared] m 2.0.0 from BRAVO failed to load on this machine (Cannot find module 'x'); this machine keeps the previous version and does not try 2.0.0 again until m is updated, or uninstalled and installed again");
  });

  it('the same after an earlier load failure of m in this process: the apply still fails', async () => {
    clearLoadFailures();
    await inPlace('m', '1.0.0');
    h.code.set('m@1.0.0', { loadThrows: new Error('Cannot find module ./commands/x') });
    expect((await reloadModule(client, 'm')).success).toBe(false);
    h.code.delete('m@1.0.0');
    const u = await rig.publish('m', files('m', '2.0.0'), '2.0.0');
    h.code.set('m@2.0.0', { initialize: () => Promise.reject(new Error("Cannot find module 'x'")) });
    const result = await rig.apply('m', u, { version: '2.0.0' });
    expect(result).toMatchObject({ outcome: 'failed', error: "Cannot find module 'x'" });
    expect(rig.entry('m')).toMatchObject({ failedSha: u, applying: null });
  });
});

describe('reloads and their starts', () => {
  it('337, 375 (the reload half), 390 (the reload half): a reload of a module whose start is open is refused with T31 by its state; nothing changes', async () => {
    const s = await inPlace('m', '1.0.0');
    const boot = startModule('m', s, '1.0.0', path.join(rig.state.source, 'm'), { boot: true });
    if (typeof boot === 'string') throw new Error(boot);
    const loads = (ModuleLoader.prototype.loadModule as any).mock.calls.length;
    expect(await reloadModule(client, 'm')).toMatchObject({ success: false, error: 'm was not reloaded: this machine is still starting it. Its start-up code runs once the bot has connected to Discord, loaded its data and started the modules before it, and the bot waits for it for at most 10 minutes. Try again after that.' });
    boot.turnAt = Date.now();
    expect(await reloadModule(client, 'm')).toMatchObject({ success: false, error: 'm was not reloaded: this machine is still running its start-up code, and waits for it for at most 10 minutes after it began. Try again once it finishes.' });
    const bulk = await reloadModules(client, ['m']);
    expect(bulk.failed).toEqual([{ moduleName: 'm', error: 'm was not reloaded: this machine is still running its start-up code, and waits for it for at most 10 minutes after it began. Try again once it finishes.' }]);
    expect((ModuleLoader.prototype.loadModule as any).mock.calls.length).toBe(loads);
    await endStart(boot, 'ok');
    expect((await reloadModule(client, 'm')).success).toBe(true);
  });

  it("338: a reload of an App Store module that is not held: starting holds its start over its window, a crash in it is counted, its end deletes the line", async () => {
    const s = await inPlace('m', '1.0.0');
    const seen: Array<{ size: number; sha: string | null }> = [];
    h.code.set('m@1.0.0', { onLoad: () => {
      seen.push({ size: starting.size, sha: [...starting][0]?.sha ?? null });
      countCrash(new Error('the reload stopped the bot'));
      seen.push({ size: 1, sha: crashLines().m?.sha ?? null });
    } });
    const out = await reloadModule(client, 'm');
    expect(out.success).toBe(true);
    expect(seen).toEqual([{ size: 1, sha: s }, { size: 1, sha: s }]);
    expect(crashLines().m).toBeUndefined();
    expect(starting.size).toBe(0);
  });

  it("360: a reload of a module whose open start has a null sha: that start ends replaced, a new one opens, the reload runs", async () => {
    placed('plain', '1.0.0');
    const old = startModule('plain', null, '1.0.0', path.join(rig.state.source, 'plain'));
    if (typeof old === 'string') throw new Error(old);
    markLate(old);
    const out = await reloadModule(client, 'plain');
    expect(out.success).toBe(true);
    expect(openStarts.get('plain')).toBeUndefined();
    await endStart(old, 'ok');
    expect(openStarts.get('plain')).toBeUndefined();
  });

  it('362: an import that throws ends the start { failed } in the finally: its line is deleted and the next reload runs', async () => {
    const s = await inPlace('m', '1.0.0');
    counted('m', s, '1.0.0');
    h.code.set('m@1.0.0', { loadThrows: new Error('Cannot find module ./commands/x') });
    const out = await reloadModule(client, 'm');
    expect(out).toMatchObject({ success: false, error: 'Cannot find module ./commands/x' });
    expect(openStarts.has('m')).toBe(false);
    expect(crashLines().m).toBeUndefined();
    h.code.delete('m@1.0.0');
    expect((await reloadModule(client, 'm')).success).toBe(true);
  });

  it("363: reloadModules with one module's import throwing: that start ends { failed }, the others reload", async () => {
    placed('a', '1.0.0');
    placed('b', '1.0.0');
    h.code.set('a@1.0.0', { loadThrows: new Error('a broke') });
    const out = await reloadModules(client, ['a', 'b']);
    expect(out.reloaded).toEqual(['b']);
    expect(out.failed).toEqual([{ moduleName: 'a', error: 'a broke' }]);
    expect(openStarts.size).toBe(0);
  });

  it('364: reloadModules whose unload in step 2 throws: every start the run opened ends { failed }; the call rejects as today', async () => {
    placed('a', '1.0.0');
    placed('b', '1.0.0');
    await reloadModules(client, ['a', 'b']);
    h.unloadThrows = new Error('the registry refused');
    await expect(reloadModules(client, ['a', 'b'])).rejects.toThrow('the registry refused');
    expect(openStarts.size).toBe(0);
    expect(isReloading('a')).toBe(false);
  });

  it('365: registerReloadedModule throws before the turn: the start ends { failed }', async () => {
    placed('a', '1.0.0');
    const { setStoppedServingHook } = await import('../../src/bot/internalSetup/utils/servingGate');
    setStoppedServingHook(() => true);
    try {
      const out = await loadModuleUnmarked(client, 'a');
      expect(out.success).toBe(false);
    } finally {
      setStoppedServingHook(null);
    }
    expect(openStarts.has('a')).toBe(false);
  });

  it("366: an initializer promise that rejects while onLoad runs: no unhandled rejection; it is the initializer failure at the turn's await", async () => {
    placed('a', '1.0.0');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const rejecting = deferredPromise();
    h.code.set('a@1.0.0', {
      initialize: () => rejecting.promise,
      onLoad: async () => {
        rejecting.reject(new Error('the initializer failed'));
        await new Promise(resolve => setTimeout(resolve, 20));
      },
    });
    const out = await loadModuleUnmarked(client, 'a');
    await new Promise(resolve => setTimeout(resolve, 20));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    expect(out.success).toBe(true);
    expect(rig.state.lines.some(l => l.startsWith('[Reloader] Command initialize failed for a:'))).toBe(true);
    expect(openStarts.has('a')).toBe(false);
  });

  it("385: reloadModules of X and Y whose Y lookup throws: X's start ends { failed }, the marks are cleared, the call rejects, the next reload of X runs", async () => {
    placed('x', '1.0.0');
    placed('y', '1.0.0');
    h.lookups = 0;
    h.throwOnLookup = 2;
    await expect(reloadModules(client, ['x', 'y'])).rejects.toThrow('EACCES');
    h.throwOnLookup = 0;
    expect(openStarts.size).toBe(0);
    expect(isReloading('x')).toBe(false);
    expect(isReloading('y')).toBe(false);
    expect((await reloadModule(client, 'x')).success).toBe(true);
  });

  it('386: reloadModules whose slash command registration throws after its modules reloaded: ended starts stay ended, a late one stays late; the call rejects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    placed('a', '1.0.0');
    placed('b', '1.0.0');
    h.code.set('b@1.0.0', { initialize: () => new Promise(() => undefined) });
    h.slashThrows = new Error('Discord answered 429');
    const run = reloadModules(client, ['a', 'b']);
    const outcome = run.then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await outcome).toBe('Discord answered 429');
    expect(openStarts.has('a')).toBe(false);
    expect(openStarts.get('b')?.late).toBe(true);
    expect(isReloading('a')).toBe(false);
  });
});

describe('reloads of a held version (92, 87)', () => {
  const T24_LOG = '[Reloader] m 1.0.0 was not loaded: this machine holds it back after the bot stopped twice while it was starting it (see the App Store tab)';
  const T24_ANSWER = 'm 1.0.0 was not loaded: this machine holds it back after the bot stopped twice while it was starting it. Update m, or uninstall and install it again, to load it on this machine.';

  /** The version in place, counted at two stops while it started, then held by the real boot rule. */
  async function heldInPlace(): Promise<string> {
    const s = await inPlace('m', '1.0.0');
    counted('m', s, '1.0.0');
    counted('m', s, '1.0.0');
    recoverModuleApplies();
    expect(rig.entry('m')).toMatchObject({ sha: s, heldSha: s });
    clearLoadFailures();
    rig.state.lines.length = 0;
    return s;
  }

  it("335: reloadModule of a held version: nothing unloaded or loaded; recorded held back; success false with T24's answer and its running log", async () => {
    await heldInPlace();
    const running = getModuleRegistry().getModule('m');
    expect(running).toBeTruthy();
    const loads = (ModuleLoader.prototype.loadModule as any).mock.calls.length;
    const out = await reloadModule(client, 'm');
    expect(out).toMatchObject({ success: false, error: T24_ANSWER });
    expect((ModuleLoader.prototype.loadModule as any).mock.calls.length).toBe(loads);
    expect(getModuleRegistry().getModule('m')).toBe(running);
    expect(getHeldBack()).toEqual(['m']);
    expect(rig.state.lines).toContain(T24_LOG);
    expect(openStarts.has('m')).toBe(false);
  });

  it("336: reloadModules with a held module among others: the held one in failed with T24's answer and not unloaded; the others reload", async () => {
    await heldInPlace();
    placed('b', '1.0.0');
    const running = getModuleRegistry().getModule('m');
    const out = await reloadModules(client, ['m', 'b']);
    expect(out.failed).toEqual([{ moduleName: 'm', error: T24_ANSWER }]);
    expect(out.reloaded).toEqual(['b']);
    expect(getModuleRegistry().getModule('m')).toBe(running);
    expect(getHeldBack()).toEqual(['m']);
    expect(rig.state.lines).toContain(T24_LOG);
    expect(openStarts.size).toBe(0);
  });
});

describe("test 64's property (lane F finding 5): any order of load paths, windows, late ends, replacements and crash counts", () => {
  type Code = 'none' | 'ok' | 'reject' | 'hang' | 'throw' | 'crash';
  type Op =
    | { kind: 'code'; at: number; code: Code }
    | { kind: 'load' | 'reload'; at: number }
    | { kind: 'bulk'; both: boolean }
    | { kind: 'settle'; reject: boolean }
    | { kind: 'advance'; ms: number }
    | { kind: 'hold'; at: number }
    | { kind: 'replace'; at: number };
  const at = fc.integer({ min: 0, max: 1 });
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant('code' as const), at, code: fc.constantFrom<Code>('none', 'ok', 'reject', 'hang', 'throw', 'crash') }),
    fc.record({ kind: fc.constantFrom('load' as const, 'reload' as const), at }),
    fc.record({ kind: fc.constant('bulk' as const), both: fc.boolean() }),
    fc.record({ kind: fc.constant('settle' as const), reject: fc.boolean() }),
    fc.record({ kind: fc.constant('advance' as const), ms: fc.constantFrom(1_000, 60_001, 10 * 60_000) }),
    fc.record({ kind: fc.constant('hold' as const), at }),
    fc.record({ kind: fc.constant('replace' as const), at }),
  );

  it('a held version never reaches loadModule, endStart acts once per start, and every start a path opened is ended or late when the path returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ends = new Map<ModuleStart, number>();
    const off = onStartEnded(start => { ends.set(start, (ends.get(start) ?? 0) + 1); });
    const loadSpy = vi.mocked(ModuleLoader.prototype.loadModule);
    let run = 0;
    try {
      await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async ops => {
        run += 1;
        const names = [`a${run}`, `b${run}`];
        const shas = new Map<string, string>();
        for (const name of names) shas.set(name, await inPlace(name, '1.0.0'));
        const held = new Set<string>();
        const pending: Array<ReturnType<typeof deferredPromise<void>>> = [];
        const codeOf = (code: Code) => {
          if (code === 'ok') return { initialize: () => Promise.resolve() };
          if (code === 'reject') return { initialize: () => Promise.reject(new Error('the initializer failed')) };
          if (code === 'hang') return { initialize: () => { const d = deferredPromise(); pending.push(d); return d.promise; } };
          if (code === 'throw') return { loadThrows: new Error('index.js threw') };
          if (code === 'crash') return { onLoad: () => { countCrash(new Error('it stopped the bot')); } };
          return {};
        };
        const path_ = async (run: () => Promise<unknown>) => {
          const calls = loadSpy.mock.calls.length;
          let done = false;
          const p = run().then(() => { done = true; }, () => { done = true; });
          for (let i = 0; i < 6 && !done; i += 1) await vi.advanceTimersByTimeAsync(60_001);
          await p;
          for (const [manifest] of loadSpy.mock.calls.slice(calls)) expect(held.has((manifest as any).name)).toBe(false);
          for (const start of openStarts.values()) {
            if (names.includes(start.module)) expect(start.late).toBe(true);
          }
        };
        for (const o of ops) {
          switch (o.kind) {
            case 'code':
              h.code.set(`${names[o.at]}@1.0.0`, codeOf(o.code));
              break;
            case 'load':
              await path_(() => loadModuleUnmarked(client, names[o.at]));
              break;
            case 'reload':
              await path_(() => reloadModule(client, names[o.at]));
              break;
            case 'bulk':
              await path_(() => reloadModules(client, o.both ? names : [names[0]]));
              break;
            case 'settle': {
              const d = pending.shift();
              if (d) (o.reject ? d.reject(new Error('the late initializer failed')) : d.resolve());
              await vi.advanceTimersByTimeAsync(10);
              break;
            }
            case 'advance':
              await vi.advanceTimersByTimeAsync(o.ms);
              break;
            case 'hold': {
              const name = names[o.at];
              if (held.has(name) || openStarts.has(name)) break;
              counted(name, shas.get(name)!, '1.0.0');
              counted(name, shas.get(name)!, '1.0.0');
              recoverModuleApplies();
              held.add(name);
              break;
            }
            case 'replace': {
              const name = names[o.at];
              const open = openStarts.get(name);
              if (open && open.sha !== null) break;
              const replaced = startModule(name, null, '1.0.0', path.join(rig.state.source, name));
              if (typeof replaced !== 'string') await endStart(replaced, 'ok');
              break;
            }
          }
        }
        for (const d of pending.splice(0)) d.resolve();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        for (const [start, n] of ends) {
          if (names.includes(start.module)) expect(n).toBe(1);
        }
        for (const name of names) expect(openStarts.has(name)).toBe(false);
      }), { numRuns: 25 });
    } finally {
      off();
    }
  });
});
