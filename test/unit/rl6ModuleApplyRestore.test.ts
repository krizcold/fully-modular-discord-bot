import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The failure path's second half (afterRestore), setBuilt, manifestVersion and the end of an apply's start
// (onApplyStartEnded) in src/bot/internalSetup/utils/moduleApply.ts, over NB6's apply rig.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { applyRig, fakeLoader, noFile, ownError, reloaderFakes } from '../helpers/nb6ApplyRig';
import { readStoreRecord, writeStoreRecord, type ModuleEntry } from '../../src/bot/internalSetup/utils/sharedRecords';
import { recoverModuleApplies, setModuleApplyClient } from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetModuleCrashes, closeWindow, countCrash, endStart, openWindow, startModule, type ModuleStart } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { isReloading } from '../../src/bot/internalSetup/utils/moduleReloader';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import type { LoadedModule } from '../../src/bot/types/moduleTypes';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const FAILING = { ...U_FILES, 'fail.txt': 'index.js threw: boom' };
const NO_CLIENT = 'this process has no Discord client to load the module with';

const realFakes = { ...reloaderFakes };

beforeEach(() => rig.setup());
afterEach(async () => {
  Object.assign(reloaderFakes, realFakes);
  setStoppedServingHook(null);
  getModuleRegistry().unregister('m');
  await rig.teardown();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

function editEntry(module: string, edit: (entry: ModuleEntry | undefined) => ModuleEntry | undefined): void {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  const next = edit(read.record.modules[module]);
  if (next) read.record.modules[module] = next;
  else delete read.record.modules[module];
  writeStoreRecord(read.record);
}

async function heldS(files: Record<string, string> = S_FILES): Promise<string> {
  const s = await rig.inPlace('m', files);
  for (let i = 0; i < 2; i += 1) {
    _resetModuleCrashes();
    const start = startModule('m', s, '1.0.0', path.join(rig.state.source, 'm'), { boot: true });
    if (typeof start === 'string') throw new Error(start);
    openWindow(start);
    countCrash(new Error(`crash ${i + 1}`));
    closeWindow(start);
  }
  _resetModuleCrashes();
  recoverModuleApplies();
  expect(rig.entry('m')).toMatchObject({ sha: s, heldSha: s });
  rig.state.lines.length = 0;
  fakeLoader.loads = [];
  return s;
}

describe('the previous version after a failed apply', () => {
  it('a recompile of the previous version that writes no file: both failed, with the compile error and no load of it', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    fakeLoader.loads = [];
    fakeLoader.compiles = [{ success: true, duration: 0, diagnostics: [] }, noFile()];
    const result = await rig.apply('m', u);
    expect(result).toEqual({ outcome: 'failed', reason: null, error: 'index.js threw: boom', loaded: false, kept: 'failed-too', previousError: 'Command failed: tsc (killed)' });
    expect(fakeLoader.loads).toEqual([{ module: 'm', sha: u }]);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u, built: null });
    expect(shared()).toEqual([
      '[Shared] m 2.0.0 from BRAVO failed to load on this machine (index.js threw: boom), and the previous version did not load either (Command failed: tsc (killed)); this machine runs without m until a version loads',
    ]);
  });

  it('a recompile that fails with no error text and no diagnostics names "the compile failed"', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    fakeLoader.compiles = [{ success: true, duration: 0, diagnostics: [] }, { success: false, duration: 0, diagnostics: [] }];
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'failed-too', previousError: 'the compile failed' });
    expect(shared()[0]).toContain('the previous version did not load either (the compile failed)');
  });

  it('a retry whose previous version does not compile either logs the retry line, not the both-failed line', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.compiles = [noFile(), noFile()];
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'failed-too', previousError: 'Command failed: tsc (killed)' });
    expect(shared()).toEqual([
      expect.stringMatching(/^\[Shared\] m 2\.0\.0 could not be compiled on this machine \(Command failed: tsc \(killed\)\); this machine keeps the previous version and tries again after \d{4}-\d\d-\d\dT[\d:.]+Z$/),
    ]);
  });

  it('with no Discord client, the previous version is not loaded and the answer says why', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    setModuleApplyClient(null);
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', error: NO_CLIENT, kept: 'failed-too', previousError: NO_CLIENT });
    expect(shared()[0]).toBe(`[Shared] m 2.0.0 from BRAVO failed to load on this machine (${NO_CLIENT}), and the previous version did not load either (${NO_CLIENT}); this machine runs without m until a version loads`);
  });

  it('a load of the previous version that fails with no error text: both failed, "the load failed", not built', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    const load = reloaderFakes.loadModuleUnmarked;
    reloaderFakes.loadModuleUnmarked = async (client, module) => {
      const answer = await load(client, module);
      return fakeLoader.loads.at(-1)?.sha === s ? { success: false, moduleName: module } : answer;
    };
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'failed-too', previousError: 'the load failed' });
    expect(rig.entry('m')).toMatchObject({ sha: s, built: null });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', error: 'index.js threw: boom; the previous version did not load either (the load failed)' })]);
  });

  it('an entry dropped while the previous version compiles is not written back by the both-failed step', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    let calls = 0;
    reloaderFakes.recompileTypeScript = async () => {
      calls += 1;
      if (calls === 2) {
        editEntry('m', () => undefined);
        return noFile();
      }
      return { success: true, duration: 0, diagnostics: [] };
    };
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'failed-too' });
    expect(rig.entry('m')).toBeUndefined();
  });
});

describe('setBuilt after the previous version loads', () => {
  it('does not mark the entry built when its sha changed during the load', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    fakeLoader.loads = [];
    fakeLoader.duringLoad = () => {
      if (fakeLoader.loads.length === 2) editEntry('m', e => (e ? { ...e, sha: 'elsewhere' } : e));
    };
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous' });
    expect(fakeLoader.loads).toEqual([{ module: 'm', sha: u }, { module: 'm', sha: s }]);
    expect(rig.entry('m')).toMatchObject({ sha: 'elsewhere', built: null });
  });

  it('does not write an entry that was dropped during the load', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    fakeLoader.loads = [];
    fakeLoader.duringLoad = () => {
      if (fakeLoader.loads.length === 2) editEntry('m', () => undefined);
    };
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous' });
    expect(rig.entry('m')).toBeUndefined();
  });
});

describe('a held previous version', () => {
  it('that does not compile is put back but not marked built', async () => {
    const s = await heldS();
    const u = await rig.publish('m', FAILING, '2.0.0');
    fakeLoader.compiles = [{ success: true, duration: 0, diagnostics: [] }, ownError('m')];
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous' });
    expect(rig.entry('m')).toMatchObject({ sha: s, heldSha: s, failedSha: u, built: null });
  });

  it('after a retry logs the retry line, not the held failed line', async () => {
    await heldS();
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.compiles = [noFile()];
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous' });
    expect(shared()).toEqual([
      expect.stringMatching(/^\[Shared\] m 2\.0\.0 could not be compiled on this machine \(Command failed: tsc \(killed\)\); this machine keeps the previous version and tries again after /),
    ]);
  });

  it('whose module.json version is not a string is named by its sha in the held-back line', async () => {
    const s = await heldS({ ...S_FILES, 'module.json': '{"name":"m","version":1}' });
    const u = await rig.publish('m', FAILING, '2.0.0');
    await rig.apply('m', u);
    expect(rig.state.lines).toContain(`[Reloader] m ${s} was not loaded: this machine holds it back after the bot stopped twice while it was starting it (see the App Store tab)`);
  });
});

describe("an apply's start that ends after its turn", () => {
  async function leftApplying(): Promise<{ s: string; u: string; start: ModuleStart }> {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.duringLoad = () => { setStoppedServingHook(() => true); };
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'deferred', reason: 'stopped-serving' });
    setStoppedServingHook(null);
    fakeLoader.duringLoad = null;
    expect(rig.entry('m')?.applying).toMatchObject({ from: s, to: u });
    rig.state.lines.length = 0;
    fakeLoader.loads = [];
    const start = startModule('m', u, '2.0.0', path.join(rig.state.source, 'm'), { boot: true });
    if (typeof start === 'string') throw new Error(start);
    return { s, u, start };
  }

  it('a start replaced by another changes nothing: the apply stays open', async () => {
    const { u, start } = await leftApplying();
    await endStart(start, 'replaced');
    expect(rig.entry('m')?.applying).toMatchObject({ to: u });
    expect(rig.live('m')).toEqual(U_FILES);
    expect(fakeLoader.loads).toEqual([]);
  });

  it('a rejected start unloads the registered module, puts the previous version back under the reload mark, with T1', async () => {
    const { s, u, start } = await leftApplying();
    getModuleRegistry().register({ manifest: { name: 'm', version: '2.0.0' }, path: path.join(rig.state.source, 'm'), commands: [], events: new Map(), panels: [], exports: new Map(), initialized: true, importedFiles: [] } as unknown as LoadedModule);
    const marks: boolean[] = [];
    const compile = reloaderFakes.recompileTypeScript;
    reloaderFakes.recompileTypeScript = async opts => {
      marks.push(isReloading('m'));
      return compile(opts);
    };
    await endStart(start, { rejected: new Error('boom') });
    expect(getModuleRegistry().getModule('m')).toBeUndefined();
    expect(rig.state.lines).toContain('[ModuleRegistry] Unloading module: m');
    expect(marks).toEqual([true]);
    expect(isReloading('m')).toBe(false);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u, applying: null });
    expect(rig.live('m')).toEqual(S_FILES);
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: 'boom' })]);
    expect(shared()).toEqual([
      '[Shared] m 2.0.0 from BRAVO failed to load on this machine (boom); this machine keeps the previous version and does not try 2.0.0 again until m is updated, or uninstalled and installed again',
    ]);
  });

  it('a store mutex busy for 60 s ends it with T33 naming the wait, the apply left open', async () => {
    const { u, start } = await leftApplying();
    const hold = await storeMutex.acquire();
    if (!hold) throw new Error('the test could not take the store mutex');
    const expected = '[Error] m: finishing its start failed (the store mutex was not free within 60 s); the bot finishes it at its next start, and until then this machine applies no change of m';
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let done = false;
      const ended = endStart(start, { rejected: new Error('boom') }).then(() => { done = true; });
      for (let i = 0; i < 20 && !done; i += 1) await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      await ended;
      expect(rig.state.lines.filter(l => l.startsWith('[Error] m:'))).toEqual([expected]);
      expect(rig.entry('m')?.applying).toMatchObject({ to: u });
    } finally {
      vi.useRealTimers();
      hold.release();
    }
    expect(fs.existsSync(path.join(rig.state.source, 'm'))).toBe(true);
  });
});
