import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 47 (wip-redesign/sheets/NB6.md decisions 43, 58, 60, 61, 67, 93, 99, 109; C16): `applyModuleChange` step by
// step with a fake loader and a scripted compile. Rows 129 to 137, 199, 215, 216, 218 to 220, 263 and 334, 355, 361,
// 375, 376 (its apply half), 377, 390 and 391.

const h = vi.hoisted(() => ({ failStoreWrites: 0 }));

vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string | Buffer, keep?: { mode: number; uid: number; gid: number }) => {
      if (String(file).endsWith('.shared-mirror.json') && String(file).includes('appstore') && h.failStoreWrites > 0) {
        h.failStoreWrites -= 1;
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
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

import fs from 'fs';
import path from 'path';
import { applyRig, fakeLoader, noFile, otherError, ownError } from '../helpers/nb6ApplyRig';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { applyModuleChange, deferredText } from '../../src/bot/internalSetup/utils/moduleApply';
import {
  endStart, markLate, startEnds, startModule, type ModuleStart,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { isReloading, reloadModule } from '../../src/bot/internalSetup/utils/moduleReloader';
import { closeMaintenanceGate, _resetMaintenance } from '../../src/bot/internalSetup/utils/maintenance';
import { setView } from '../helpers/nb6Mirror';
import { storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';
import type { Client } from 'discord.js';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n', 'lib/old-only.js': '1' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const FAILING = { ...U_FILES, 'fail.txt': 'index.js threw: boom' };

beforeEach(() => rig.setup());
afterEach(async () => {
  _resetMaintenance();
  await rig.teardown();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

/** Everything an apply could touch: the three folders, the entry, the status rows, the loads. */
function snapshot(module: string) {
  return { live: rig.live(module), built: rig.built(module), dist: rig.dist(module), entry: rig.entry(module), status: rig.status(module), loads: fakeLoader.loads.length, backups: rig.backupsOf(module) };
}

describe('the swap, the compile and the load', () => {
  it('row 129: a version that dropped files replaces source, build and dist whole', async () => {
    await rig.inPlace('m', S_FILES);
    rig.writeTree(path.join(rig.state.dist, 'm'), { 'index.js': 'compiled S', 'lib/old-only.js': 'compiled' });
    const u = await rig.publish('m', U_FILES, '2.0.0');
    await rig.apply('m', u);
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.built('m')).toEqual(U_FILES);
    expect(rig.dist('m')).toBeNull();
  });

  it('row 130: compile errors only in another module\'s files: the module loads, entry and status applied', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.compiles = [otherError()];
    const result = await rig.apply('m', u);
    expect(result.outcome).toBe('applied');
    expect(rig.entry('m')).toMatchObject({ sha: u, failedSha: null });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: u })]);
  });

  it('row 131: errors in the module\'s own files take the failure path: failedSha, T1, a failed status', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.loads = [];
    fakeLoader.compiles = [ownError('m')];
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', error: "build/bot/modules/m/index.ts:3 Type 'string' is not assignable to type 'number'." });
    expect(fakeLoader.loads).toEqual([{ module: 'm', sha: s }]);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u })]);
    expect(shared()).toEqual([expect.stringMatching(/^\[Shared\] m 2\.0\.0 from BRAVO failed to load on this machine \(build\/bot\/modules\/m\/index\.ts:3 /)]);
  });

  it('rows 132 and 199: a load failure in a running bot: build and dist emptied, the new folder to -failed, the backup renamed back and copied to build, compiled and loaded', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    fakeLoader.loads = [];
    const compiles = fakeLoader.compileCalls;
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous' });
    expect(fakeLoader.compileCalls).toBe(compiles + 2);
    expect(fakeLoader.loads).toEqual([{ module: 'm', sha: u }, { module: 'm', sha: s }]);
    expect(rig.live('m')).toEqual(S_FILES);
    expect(rig.built('m')).toEqual(S_FILES);
    expect(rig.dist('m')).toBeNull();
    const [failed] = rig.backupsOf('m');
    expect(failed).toMatch(/^m-\d+-failed$/);
    expect(rig.readTree(path.join(rig.state.backups, failed))).toEqual(FAILING);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u, built: { sha: s, buildId: null } });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: 'index.js threw: boom' })]);
  });

  it('row 133: a compile failure that names no file restores with no failedSha, retryAt 10 minutes on, T2, a failed status', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.compiles = [noFile()];
    const before = Date.now();
    const result = await rig.apply('m', u);
    expect(result.outcome).toBe('failed');
    const entry = rig.entry('m')!;
    expect(entry).toMatchObject({ sha: s, failedSha: null });
    expect(entry.retryAt).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(entry.retryAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: 'Command failed: tsc (killed)' })]);
    expect(shared()).toEqual([`[Shared] m 2.0.0 could not be compiled on this machine (Command failed: tsc (killed)); this machine keeps the previous version and tries again after ${new Date(entry.retryAt!).toISOString()}`]);
  });

  it('row 134: the restored version fails too: unloaded, built null, failedSha, T3, the status naming both errors', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    fakeLoader.compiles = [{ success: true, duration: 0, diagnostics: [] }, ownError('m', 'the old version no longer compiles')];
    fakeLoader.unloads = [];
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'failed-too' });
    expect(fakeLoader.unloads).toEqual(['m']);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u, built: null });
    const second = 'build/bot/modules/m/index.ts:3 the old version no longer compiles';
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', error: `index.js threw: boom; the previous version did not load either (${second})` })]);
    expect(shared()).toEqual([`[Shared] m 2.0.0 from BRAVO failed to load on this machine (index.js threw: boom), and the previous version did not load either (${second}); this machine runs without m until a version loads`]);
  });

  it('row 135: a new install that fails to load: its folder to -failed, no folder, the entry absent with failedSha, T1 "no copy of it"', async () => {
    const u = await rig.publish('m', FAILING, '2.0.0');
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'none' });
    expect(rig.live('m')).toBeNull();
    expect(rig.built('m')).toBeNull();
    expect(rig.backupsOf('m')).toEqual([expect.stringMatching(/^m-\d+-failed$/)]);
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', failedSha: u });
    expect(shared()).toEqual(['[Shared] m 2.0.0 from BRAVO failed to load on this machine (index.js threw: boom); this machine keeps no copy of it and does not try 2.0.0 again until m is updated, or uninstalled and installed again']);
  });

  it('row 136: a removal whose unload fails still removes the folders and drops the entry, with T6', async () => {
    await rig.inPlace('m', S_FILES);
    fakeLoader.unloadFails = 'a listener would not detach';
    const result = await rig.apply('m', 'absent');
    expect(result.outcome).toBe('applied');
    expect(rig.live('m')).toBeNull();
    expect(rig.built('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
    expect(shared()).toEqual(["[Shared] m was removed from this machine's files, but unloading it failed (a listener would not detach); it keeps running until the bot restarts"]);
  });

  it('row 137: a live folder that is neither the entry\'s version nor absent goes to _superseded and from is absent, with T11 (a)', async () => {
    await rig.inPlace('m', S_FILES);
    fs.writeFileSync(path.join(rig.state.source, 'm', 'index.js'), 'edited by hand');
    const u = await rig.publish('m', FAILING, '2.0.0');
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'none' });
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', failedSha: u });
    const moved = shared().find(l => l.startsWith('[Shared] Moved'));
    expect(moved).toMatch(/_superseded.+: it differed from the version this machine last took from the database \(changed outside the bot, or left by a crash\); the database's version failed to load on this machine \(see the line above\)$/);
  });
});

describe('step 1 and the entries a caller sees', () => {
  it('row 215: a main tag other than the change\'s ends deferred main-changed and touches nothing, T18', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const before = snapshot('m');
    setView(2, 'BRAVO');
    const result = await rig.apply('m', u);
    expect(result).toEqual({ outcome: 'deferred', reason: 'main-changed', error: null, loaded: false });
    expect(snapshot('m')).toEqual(before);
    expect(deferredText('update', 'm', '2.0.0', result)).toBe("m 2.0.0 was updated. This machine applies the database's current version of m at its next pass (the main database changed).");
    expect(s).not.toBe(u);
  });

  it('row 216: the entry a publish\'s apply writes takes the publish\'s tag', async () => {
    setView(3, 'ALPHA');
    const u = await rig.publish('m', U_FILES, '2.0.0');
    await rig.apply('m', u, { tag: '3:ALPHA', reason: 'install' });
    expect(rig.entry('m')).toMatchObject({ sha: u, main: '3:ALPHA' });
  });

  it('rows 218 and 376: with the gate closed the apply ends deferred maintenance with nothing touched; the first pass after it opens applies', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const before = snapshot('m');
    closeMaintenanceGate('hook', 'maintenance began');
    expect(await rig.apply('m', u)).toMatchObject({ outcome: 'deferred', reason: 'maintenance' });
    await rig.pass();
    expect(snapshot('m')).toEqual(before);
    _resetMaintenance();
    await rig.pass();
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.entry('m')?.sha).toBe(u);
  });

  it('row 219: a removal unloads with the reload mark held', async () => {
    await rig.inPlace('m', S_FILES);
    const marked: boolean[] = [];
    const { reloaderFakes } = await import('../helpers/nb6FakeLoader');
    const unload = reloaderFakes.unloadModuleUnmarked;
    reloaderFakes.unloadModuleUnmarked = async (client, module) => {
      marked.push(isReloading(module));
      return unload(client, module);
    };
    try {
      await rig.apply('m', 'absent');
    } finally {
      reloaderFakes.unloadModuleUnmarked = unload;
    }
    expect(marked).toEqual([true]);
    expect(isReloading('m')).toBe(false);
  });

  it('row 220: a reload during the failure path answers "Module is already being reloaded" until the apply ends', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    const answers: string[] = [];
    fakeLoader.duringLoad = async () => {
      const out = await reloadModule({} as Client, 'm');
      answers.push(out.error ?? 'reloaded');
    };
    await rig.apply('m', u);
    expect(answers).toEqual(['Module is already being reloaded', 'Module is already being reloaded']);
    expect(isReloading('m')).toBe(false);
  });
});

describe('an open start of the module (decisions 93, 99 and 109)', () => {
  function opened(sha: string | null, opts?: { boot: true }): ModuleStart {
    const start = startModule('m', sha, '1.0.0', path.join(rig.state.source, 'm'), opts);
    if (typeof start === 'string') throw new Error(start);
    return start;
  }

  it('rows 263 and 334: a late start of the version in place: the apply ends deferred starting (a) and the pass skips it', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const start = opened(s, { boot: true });
    start.turnAt = Date.now();
    markLate(start);
    const before = snapshot('m');
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'deferred', reason: 'starting', state: 'a' });
    expect(deferredText('update', 'm', '2.0.0', result)).toBe("m 2.0.0 was updated. This machine applies the database's current version of m at the first pass after it finishes starting m (its start-up code is still running, and the bot waits for it for at most 10 minutes after it began).");
    await rig.pass();
    expect(snapshot('m')).toEqual(before);
    await endStart(start, 'ok');
    await rig.pass();
    expect(rig.entry('m')?.sha).toBe(u);
  });

  it('row 375: a boot start before its turn: deferred starting with T18 (c)', async () => {
    const s = await rig.inPlace('m', S_FILES);
    opened(s, { boot: true });
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ reason: 'starting', state: 'c' });
    expect(deferredText('update', 'm', '2.0.0', result)).toBe("m 2.0.0 was updated. This machine applies the database's current version of m at the first pass after it finishes starting m (its start-up code runs once the bot has connected to Discord, loaded its data and started the modules before it, and the bot waits for it for at most 10 minutes).");
  });

  it('row 377: a live start before its turn (a load in progress): deferred starting with T18 (d)', async () => {
    const s = await rig.inPlace('m', S_FILES);
    opened(s);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ reason: 'starting', state: 'd' });
    expect(deferredText('install', 'm', '2.0.0', result)).toBe("m 2.0.0 was installed. This machine applies the database's current version of m at the first pass after it finishes starting m (it is loading m right now).");
  });

  it('row 361: an open start with a null sha defers nothing', async () => {
    opened(null);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    expect((await rig.apply('m', u)).outcome).toBe('applied');
  });

  it('row 376: the gate closed answers maintenance before starting', async () => {
    const s = await rig.inPlace('m', S_FILES);
    opened(s, { boot: true });
    closeMaintenanceGate('hook', 'maintenance began');
    const u = await rig.publish('m', U_FILES, '2.0.0');
    expect(await rig.apply('m', u)).toMatchObject({ outcome: 'deferred', reason: 'maintenance' });
  });
});

describe('a late apply start whose end fails or still runs (decisions 101 and 109)', () => {
  /** A live apply whose start went late: the entry keeps applying, the start is in openStarts. */
  async function lateApply(): Promise<{ start: ModuleStart; s: string; u: string }> {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const { reloaderFakes } = await import('../helpers/nb6FakeLoader');
    const load = reloaderFakes.loadModuleUnmarked;
    let start: ModuleStart | null = null;
    reloaderFakes.loadModuleUnmarked = async (client, module) => {
      const out = await load(client, module);
      const begun = startModule(module, u, '2.0.0', path.join(rig.state.source, module));
      if (typeof begun === 'string') throw new Error(begun);
      begun.turnAt = Date.now();
      markLate(begun);
      start = begun;
      return { ...out, start: begun, late: true };
    };
    try {
      const result = await rig.apply('m', u);
      expect(result).toEqual({ outcome: 'loaded', reason: null, error: null, loaded: true });
    } finally {
      reloaderFakes.loadModuleUnmarked = load;
    }
    expect(rig.entry('m')?.applying).toMatchObject({ from: s, to: u });
    return { start: start!, s, u };
  }

  it('rows 354 to 355: a finish that throws before its record write leaves applying and startEnds failed: deferred (e), the pass skips', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const { reloaderFakes } = await import('../helpers/nb6FakeLoader');
    const load = reloaderFakes.loadModuleUnmarked;
    let start: ModuleStart | null = null;
    reloaderFakes.loadModuleUnmarked = async (client, module) => {
      const out = await load(client, module);
      const begun = startModule(module, u, '2.0.0', path.join(rig.state.source, module));
      if (typeof begun === 'string') throw new Error(begun);
      begun.turnAt = Date.now();
      markLate(begun);
      start = begun;
      return { ...out, start: begun, late: true };
    };
    try {
      await rig.apply('m', u);
    } finally {
      reloaderFakes.loadModuleUnmarked = load;
    }
    // The store record's write refused once, as a full disk refuses it, while the finish writes step 6's entry.
    h.failStoreWrites = 1;
    await endStart(start!, 'ok');
    h.failStoreWrites = 0;
    expect(rig.entry('m')?.applying).toMatchObject({ to: u });
    expect(startEnds.get('m')).toBe('failed');
    expect(rig.state.lines).toContain("[Error] m: finishing its start failed (ENOSPC: no space left on device, write); the bot finishes it at its next start, and until then this machine applies no change of m");
    const v = await rig.publish('m', { ...U_FILES, 'v3.js': '3' }, '3.0.0');
    const result = await rig.apply('m', v);
    expect(result).toMatchObject({ outcome: 'deferred', reason: 'starting', state: 'e' });
    expect(deferredText('update', 'm', '3.0.0', result)).toBe("m 3.0.0 was updated. Finishing the last change of m failed on this machine (see the bot's log), so it applies the database's current version of m after the bot's next start.");
    fakeLoader.loads = [];
    await rig.pass();
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.live('m')).toEqual(U_FILES);
    expect(s).not.toBe(u);
  });

  it('rows 390 and 391: while a late start\'s end waits on the store mutex the apply ends deferred (f) and the pass skips; once it finishes the pass applies', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const { reloaderFakes } = await import('../helpers/nb6FakeLoader');
    const load = reloaderFakes.loadModuleUnmarked;
    let start: ModuleStart | null = null;
    reloaderFakes.loadModuleUnmarked = async (client, module) => {
      const out = await load(client, module);
      const begun = startModule(module, u, '2.0.0', path.join(rig.state.source, module));
      if (typeof begun === 'string') throw new Error(begun);
      begun.turnAt = Date.now();
      markLate(begun);
      start = begun;
      return { ...out, start: begun, late: true };
    };
    try {
      await rig.apply('m', u);
    } finally {
      reloaderFakes.loadModuleUnmarked = load;
    }
    // Another App Store section holds the store mutex, so the end's failure path (67) waits for it.
    const other = await storeMutex.acquire();
    const ending = endStart(start!, { rejected: new Error('a late initializer rejected') });
    await new Promise(resolve => setTimeout(resolve, 10));
    const v = await rig.publish('m', { ...U_FILES, 'v3.js': '3' }, '3.0.0');
    const result = await applyModuleChange({ module: 'm', to: v, source: 'rows', displaced: 'backups', reason: 'pass', tag: '1:ALPHA', version: '3.0.0' });
    expect(result).toMatchObject({ outcome: 'deferred', reason: 'starting', state: 'f' });
    expect(deferredText('update', 'm', '3.0.0', result)).toBe("m 3.0.0 was updated. This machine is still finishing its last change of m; it applies the database's current version of m at the first pass after that finishes, or after the bot's next start if finishing fails.");
    fakeLoader.loads = [];
    await rig.pass();
    expect(fakeLoader.loads).toEqual([]);
    other!.release();
    await ending;
    expect(startEnds.has('m')).toBe(false);
    expect(rig.entry('m')?.applying ?? null).toBeNull();
    expect(rig.entry('m')).toMatchObject({ failedSha: u });
    await rig.pass();
    expect(rig.entry('m')?.sha).toBe(v);
  });
});
