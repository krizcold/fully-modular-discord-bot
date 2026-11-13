import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import path from 'path';
import { bootRig } from '../helpers/nb6BootRig';
import { noFile, ownError, reloaderFakes } from '../helpers/nb6FakeLoader';
import type { CompileResult } from '../../src/bot/internalSetup/utils/moduleReloader';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { bootLoadCheck } from '../../src/bot/internalSetup/utils/moduleApply';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import {
  _resetModuleCrashes, closeWindow, countCrash, openStarts, openWindow, startFailureOf, startModule, starting,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { clearLoadFailures, getHeldBack, getLoadFailures, recordLoadFailure } from '../../src/bot/internalSetup/utils/loadFailures';

const rig = bootRig();
const shared = () => rig.apply.state.lines.filter(l => l.startsWith('[Shared]'));
const T24 = '[ModuleLoader] m 1.0.0 was not loaded: this machine holds it back after the bot stopped twice while it was starting it (see the App Store tab)';
const HELD_TAIL = 'It keeps the previous version on disk but does not load it: that version is held back after the bot stopped twice while it was starting it';
const CLEAN: CompileResult = { success: true, duration: 0, diagnostics: [] };

/** Runs before the rig's fake load of a module version ("name@version"); a throw there is the load's throw. */
const before = new Map<string, () => void>();
const loadsOf: string[] = [];

beforeEach(async () => {
  await rig.setup();
  h.manifests = rig.manifests;
  clearLoadFailures();
  before.clear();
  loadsOf.length = 0;
  const spy = vi.mocked(ModuleLoader.prototype.loadModule);
  const base = spy.getMockImplementation()!;
  spy.mockImplementation(async function (this: ModuleLoader, manifest: any, dir: string) {
    const key = `${manifest.name}@${manifest.version}`;
    loadsOf.push(key);
    before.get(key)?.();
    return base.call(this, manifest, dir);
  });
});
afterEach(async () => {
  clearLoadFailures();
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

/** The applied version records a load failure for a file of its dist folder and loads: the check fails it. */
function failByDistFile(key: string, then?: () => void): void {
  before.set(key, () => {
    recordLoadFailure(path.join(rig.apply.state.dist, 'm', 'commands', 'ping.js'));
    then?.();
  });
}

const statusOf = (module: string) => rig.apply.status(module).map(s => ({ state: s.state, sha: s.sha, error: s.error }));

describe('the restored version held back at boot', () => {
  it('after a failed load: written built for its sha when it compiled', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    crashTwice('m', s, '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.code.set('m@2.0.0', { loadThrows: new Error('index.js threw: boom') });
    await rig.boot();
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, heldSha: s, failedSha: u, built: { sha: s, buildId: null }, applying: null });
    expect(rig.loaded()).toEqual([]);
  });

  it('after its compile failed at boot: the held-back line is logged once, by the loader', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    crashTwice('m', s, '1.0.0');
    await rig.publish('m', '2.0.0');
    rig.compiles.results = [ownError('m')];
    await rig.boot();
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, heldSha: s, applying: null });
    expect(rig.apply.state.lines.filter(l => l === T24)).toHaveLength(1);
    expect(getHeldBack()).toEqual(['m']);
    expect(rig.loaded()).toEqual([]);
  });

  it('after a compile that named no file: the retry line, not the failed-held line', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    crashTwice('m', s, '1.0.0');
    await rig.publish('m', '2.0.0');
    rig.compiles.results = [noFile()];
    await rig.boot();
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, heldSha: s, applying: null });
    expect(shared().some(l => l.startsWith('[Shared] m 2.0.0 could not be compiled on this machine (Command failed: tsc (killed)); this machine keeps the previous version and tries again after '))).toBe(true);
    expect(shared().filter(l => l.includes(HELD_TAIL))).toEqual([]);
    expect(rig.loaded()).toEqual([]);
  });
});

describe('the restored version does not load either after a failed load at boot', () => {
  async function bothFail(second: CompileResult): Promise<{ s: string; u: string }> {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.code.set('m@2.0.0', { loadThrows: new Error('index.js threw: boom') });
    rig.compiles.results = [CLEAN, second];
    await rig.boot();
    return { s, u };
  }

  it("its own compile error: not loaded, build and dist deleted, built null, a failed status naming both errors, T3's line", async () => {
    const { s, u } = await bothFail(ownError('m', 'restored bad'));
    const second = 'build/bot/modules/m/index.ts:3 restored bad';
    expect(rig.loaded()).toEqual([]);
    expect(loadsOf).toEqual(['m@2.0.0']);
    expect(rig.apply.built('m')).toBeNull();
    expect(rig.apply.dist('m')).toBeNull();
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, built: null, failedSha: u, applying: null });
    expect(statusOf('m')).toEqual([{ state: 'failed', sha: u, error: `index.js threw: boom; the previous version did not load either (${second})` }]);
    expect(shared().some(l => /^\[Shared\] m 2\.0\.0 from .+ failed to load on this machine \(index\.js threw: boom\), and the previous version did not load either \(build\/bot\/modules\/m\/index\.ts:3 restored bad\); this machine runs without m until a version loads$/.test(l))).toBe(true);
  });

  it('a compile that fails with no file and no error text: the status names the compile failed', async () => {
    const { u } = await bothFail({ success: false, duration: 0, diagnostics: [] });
    expect(rig.loaded()).toEqual([]);
    expect(statusOf('m')).toEqual([{ state: 'failed', sha: u, error: 'index.js threw: boom; the previous version did not load either (the compile failed)' }]);
  });

  it('an entry removed while the restored version loads is not written again', async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.publish('m', '2.0.0');
    rig.code.set('m@2.0.0', { loadThrows: new Error('index.js threw: boom') });
    before.set('m@1.0.0', () => {
      const read = readStoreRecord();
      if (!read.ok) throw new Error(read.reason);
      delete read.record.modules.m;
      writeStoreRecord(read.record);
      throw new Error('v1 gone');
    });
    await rig.boot();
    expect(loadsOf).toEqual(['m@2.0.0', 'm@1.0.0']);
    expect(rig.apply.entry('m')).toBeUndefined();
    expect(rig.loaded()).toEqual([]);
  });

  it("the restored version's manifest not found: recorded as a load failure, named in the status", async () => {
    await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    failByDistFile('m@2.0.0', () => { h.manifests = () => []; });
    await rig.boot();
    expect(loadsOf).toEqual(['m@2.0.0']);
    expect(getLoadFailures()).toContain('m');
    expect(statusOf('m')).toEqual([{ state: 'failed', sha: u, error: 'm recorded a load failure; the previous version did not load either (Module manifest not found)' }]);
    expect(rig.loaded()).toEqual([]);
  });

  it('a start of m still open when the restored version would start: the status names m was not loaded', async () => {
    await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.code.set('m@2.0.0', { loadThrows: new Error('index.js threw: boom') });
    const compile = reloaderFakes.recompileTypeScript;
    let calls = 0;
    reloaderFakes.recompileTypeScript = async opts => {
      const out = await compile(opts);
      calls += 1;
      if (calls === 2) startModule('m', 'f'.repeat(64), '9.9.9', path.join(rig.apply.state.dist, 'm'));
      return out;
    };
    await rig.boot();
    expect(calls).toBe(2);
    expect(loadsOf).toEqual(['m@2.0.0']);
    expect(statusOf('m')).toEqual([{ state: 'failed', sha: u, error: 'index.js threw: boom; the previous version did not load either (m was not loaded)' }]);
  });

  it("the restored version's load throws: logged, recorded, its start ended failed with that error", async () => {
    await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    failByDistFile('m@2.0.0');
    rig.code.set('m@1.0.0', { loadThrows: new Error('v1 boom') });
    await rig.boot();
    expect(loadsOf).toEqual(['m@2.0.0', 'm@1.0.0']);
    expect(rig.apply.state.lines).toContain('[ModuleLoader] Failed to load module m: Error: v1 boom');
    expect(getLoadFailures()).toContain('m');
    expect(openStarts.has('m')).toBe(false);
    expect(startFailureOf('m')).toBe('v1 boom');
    expect(statusOf('m')).toEqual([{ state: 'failed', sha: u, error: 'm recorded a load failure; the previous version did not load either (v1 boom)' }]);
    expect(rig.loaded()).toEqual([]);
  });

  it('a load that throws no error: its start ends failed with "the load did not finish"', async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.publish('m', '2.0.0');
    failByDistFile('m@2.0.0');
    before.set('m@1.0.0', () => { throw undefined; });
    await rig.boot();
    expect(loadsOf).toEqual(['m@2.0.0', 'm@1.0.0']);
    expect(openStarts.has('m')).toBe(false);
    expect(startFailureOf('m')).toBe('the load did not finish');
  });
});

describe('the restored version loads after a failed load at boot', () => {
  it('in its start window, with its onLoad and onReady hooks run and a hook throw logged', async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.publish('m', '2.0.0');
    rig.code.set('m@2.0.0', { loadThrows: new Error('index.js threw: boom') });
    const seen: string[] = [];
    let inWindow: boolean | null = null;
    before.set('m@1.0.0', () => { inWindow = [...starting].some(s => s.module === 'm'); });
    rig.code.set('m@1.0.0', {
      onLoad: () => { seen.push('onLoad'); },
      onReady: () => { seen.push('onReady'); throw new Error('hook boom'); },
    });
    await rig.boot();
    expect(rig.loaded()).toEqual(['m@1.0.0']);
    expect(inWindow).toBe(true);
    expect([...starting].some(s => s.module === 'm')).toBe(false);
    expect(seen).toEqual(['onLoad', 'onReady']);
    expect(rig.apply.state.lines).toContain('[ModuleLoader] onReady hook failed for m: Error: hook boom');
  });

  it('the restored module is found by its own manifest when another module lists first', async () => {
    await rig.inPlace('a', '1.0.0');
    await rig.inPlace('b', '1.0.0');
    await rig.publish('b', '2.0.0');
    rig.code.set('b@2.0.0', { loadThrows: new Error('index.js threw: boom') });
    await rig.boot();
    expect(rig.manifests().map(p => path.basename(path.dirname(p)))).toEqual(['a', 'b']);
    expect(rig.loaded()).toEqual(['a@1.0.0', 'b@1.0.0']);
    expect(loadsOf.filter(k => k === 'a@1.0.0')).toHaveLength(1);
  });
});

describe('the load check takes the boot applies once', () => {
  it('a second check in the same process changes nothing for a module the first one passed', async () => {
    await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    await rig.boot();
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    recordLoadFailure('m');
    const loaded = getModuleRegistry().getAllModules();
    const out = await bootLoadCheck(rig.client, loaded);
    expect(out).toBe(loaded);
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    expect(rig.apply.entry('m')?.applying).toMatchObject({ to: u });
    expect(loadsOf).toEqual(['m@2.0.0']);
  });
});
