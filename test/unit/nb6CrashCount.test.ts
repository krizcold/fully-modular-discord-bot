import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 60, part 15: the crash count (decisions 66, 100, 107, 112 and 114 of wip-redesign/sheets/NB6.md), driven
// through `guardUncaught`, the starts' windows and `endStart`, with the crash file on the test's data root. Part 16
// adds the boot rule and 49 step 7 (rows 257, 258, 302, 303 and 419) and the apply half of row 126, over the real apply
// with the fake loader of helpers/nb6ApplyRig.ts. Row 307 is in nb6StartModule.test.ts (the real reloader); row 384
// needs 45 (6)'s f at boot (part 18).

const h = vi.hoisted(() => ({
  failCrashWrites: 0,
  crashWrites: 0,
  draining: false,
  manifests: null as string[] | null,
}));

vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string | Buffer, keep?: { mode: number; uid: number; gid: number }) => {
      if (String(file).endsWith('module-crashes.json')) {
        h.crashWrites++;
        if (h.failCrashWrites > 0) {
          h.failCrashWrites--;
          throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
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
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return { ...real, isExitDraining: () => h.draining || real.isExitDraining() };
});
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  return { ...real, findModuleManifests: () => (h.manifests === null ? real.findModuleManifests() : h.manifests) };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { dataPath } from '../../src/utils/dataRoot';
import {
  _resetModuleCrashes,
  bootStartOf,
  closeWindow,
  endStart,
  frameUnder,
  keptEnds,
  markLate,
  onModuleCode,
  onStartEnded,
  openStarts,
  openWindow,
  retryKeptEnds,
  startModule,
  startShaOf,
  type ModuleStart,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { closeMaintenanceGate, guardUncaught, _resetMaintenance } from '../../src/bot/internalSetup/utils/maintenance';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { writeStoreRecord, type ModuleEntry } from '../../src/bot/internalSetup/utils/sharedRecords';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { checkWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { reopenSharedWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { freshWriterLock } from '../helpers/nb10Rig';
import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { recoverModuleApplies } from '../../src/bot/internalSetup/utils/moduleApply';

const CRASH_FILE = dataPath('global', 'appstore', 'cache', 'module-crashes.json');
const COUNT_LINE = '[Error] The module crash count could not be written';
const OTHER = 5461;
const nodeRequire = createRequire(import.meta.url);

let tmp: string;
let exit: ReturnType<typeof vi.spyOn>;
let errors: string[];
const removeEndListeners: Array<() => void> = [];

function crashLines(): Record<string, { sha: string; n: number; version: string; error: string; at: string }> {
  return fs.existsSync(CRASH_FILE) ? JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8')) : {};
}

function crashBytes(): string | null {
  return fs.existsSync(CRASH_FILE) ? fs.readFileSync(CRASH_FILE, 'utf8') : null;
}

/** A module folder under the temp dir whose index.js holds functions that throw from that file. */
function moduleDir(name: string): { dir: string; boom: (message?: string) => never; call: (fn: () => void) => void } {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.js');
  fs.writeFileSync(file, "exports.boom = message => { throw new Error(message || 'thrown in the module'); };\nexports.call = fn => fn();\n");
  return nodeRequire(file);
}

function dirOf(name: string): string {
  return path.join(tmp, name);
}

/** The error a module's own code throws: its stack holds a frame of the module's index.js. */
function thrownIn(name: string, message = `${name} broke`): Error {
  const mod = nodeRequire(path.join(dirOf(name), 'index.js'));
  try {
    mod.boom(message);
  } catch (error) {
    return error as Error;
  }
  throw new Error('unreachable');
}

/** An error thrown from this test file: no frame under any module folder. */
function thrownHere(message = 'thrown by another handler'): Error {
  return new Error(message);
}

function opened(name: string, sha: string | null, opts?: { boot: true }): ModuleStart {
  moduleDir(name);
  const start = startModule(name, sha, '1.0.0', dirOf(name), opts);
  if (typeof start === 'string') throw new Error(`start refused: ${start}`);
  return start;
}

/** Runs `guardUncaught` while `start`'s window is open, as an uncaught throw inside that window does. */
function crashIn(start: ModuleStart, error: unknown = thrownHere()): void {
  openWindow(start);
  try {
    guardUncaught(error);
  } finally {
    closeWindow(start);
  }
}

function entryOf(sha: string): ModuleEntry {
  return { sha, stamp: null, files: {}, main: null, built: { sha, buildId: null }, failedSha: null, retryAt: null };
}

/** M's start of S ended while the disk refused its line delete (row 358): `keptEnds` holds M and S. */
async function keptAfter358(name: string, sha: string): Promise<void> {
  const start = opened(name, sha);
  crashIn(start);
  expect(crashLines()[name]).toMatchObject({ sha, n: 1 });
  h.failCrashWrites = 1;
  await endStart(start, 'ok');
  expect(keptEnds.get(name)).toBe(sha);
}

function armedRetry(): ((code: number) => void) | undefined {
  return process.listeners('exit').find(l => l === retryKeptEnds) as ((code: number) => void) | undefined;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb6crash-'));
  h.failCrashWrites = 0;
  h.crashWrites = 0;
  h.draining = false;
  h.manifests = null;
  errors = [];
  fs.rmSync(CRASH_FILE, { recursive: true, force: true });
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(() => {
  for (const remove of removeEndListeners.splice(0)) remove();
  _resetModuleCrashes();
  _resetMaintenance();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the count through guardUncaught (66, 100)', () => {
  it("249: the boot loop's start of M, set through onModuleCode, is counted when M's onLoad stops the bot", async () => {
    moduleDir('m-boot');
    writeStoreRecord({ docs: {}, modules: { 'm-boot': entryOf('S1') } });
    const manifest = path.join(dirOf('m-boot'), 'module.json');
    fs.writeFileSync(manifest, JSON.stringify({ name: 'm-boot', version: '2.0.0', displayName: 'M', description: 'd', author: 'a', category: 'misc' }));
    h.manifests = [manifest];
    vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async (m: any, p: string) => ({
      manifest: m, path: p, commands: [], events: new Map(), panels: [], exports: new Map(), initialized: false, importedFiles: [],
      hooks: { onLoad: () => { guardUncaught(thrownIn('m-boot', 'onLoad failed')); } },
    }) as any);

    const loaded = await new ModuleLoader({} as any, { onModuleCode }).loadAllModules();

    expect(loaded.map(m => m.manifest.name)).toEqual(['m-boot']);
    expect(exit).toHaveBeenCalledWith(1);
    const line = crashLines()['m-boot'];
    expect(line).toMatchObject({ sha: 'S1', n: 1, version: '2.0.0', error: 'onLoad failed' });
    expect(new Date(line.at).toISOString()).toBe(line.at);
    const handed = bootStartOf('m-boot');
    expect(handed).toMatchObject({ module: 'm-boot', sha: 'S1', version: '2.0.0', dir: dirOf('m-boot'), boot: true, late: false });
    expect(openStarts.get('m-boot')).toBe(handed);
    await getModuleRegistry().unloadModule('m-boot');
  });

  it("the boot loop's start of a module whose load throws ends { failed } in its finally: the line of its sha is deleted", async () => {
    moduleDir('m-bad');
    writeStoreRecord({ docs: {}, modules: { 'm-bad': entryOf('B1') } });
    crashIn(opened('m-bad', 'B1'));
    expect(crashLines()['m-bad']).toMatchObject({ sha: 'B1', n: 1 });
    _resetModuleCrashes();
    const manifest = path.join(dirOf('m-bad'), 'module.json');
    fs.writeFileSync(manifest, JSON.stringify({ name: 'm-bad', version: '1.0.0', displayName: 'B', description: 'd', author: 'a', category: 'misc' }));
    h.manifests = [manifest];
    vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async () => { throw new Error('import failed'); });
    const ended: unknown[] = [];
    removeEndListeners.push(onStartEnded((start, result) => { ended.push([start.module, start.sha, result]); }));

    const loaded = await new ModuleLoader({} as any, { onModuleCode }).loadAllModules();

    expect(loaded).toEqual([]);
    expect(crashLines()['m-bad']).toBeUndefined();
    expect(openStarts.has('m-bad')).toBe(false);
    expect(bootStartOf('m-bad')).toBeUndefined();
    expect(ended).toHaveLength(1);
    expect(ended[0]).toEqual(['m-bad', 'B1', { failed: expect.objectContaining({ message: 'import failed' }) }]);
  });

  it('254: another module\'s handler throws while starting names M: counted against M', () => {
    const m = opened('m254', 'S254');
    crashIn(m, thrownHere('a handler of another module threw'));
    expect(crashLines()).toEqual({ m254: expect.objectContaining({ sha: 'S254', n: 1, error: 'a handler of another module threw' }) });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('256: process.exit from module code inside a window never reaches guardUncaught and counts nothing', () => {
    const m = opened('m256', 'S256');
    openWindow(m);
    process.exit(3);
    closeWindow(m);
    expect(exit).toHaveBeenCalledWith(3);
    expect(crashBytes()).toBeNull();
  });

  it('261: the crash file cannot be written: logged, exit(1) goes on, no count', () => {
    fs.mkdirSync(CRASH_FILE, { recursive: true });
    crashIn(opened('m261', 'S261'));
    expect(errors.some(e => e.startsWith(`${COUNT_LINE} (`))).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.statSync(CRASH_FILE).isDirectory()).toBe(true);
  });

  it('261: the atomic write throws: logged with its error, exit(1) goes on, the file keeps its bytes', () => {
    crashIn(opened('m261b', 'S261'));
    const before = crashBytes();
    h.failCrashWrites = 1;
    crashIn(openStarts.get('m261b')!);
    expect(errors).toContain(`${COUNT_LINE} (EIO: i/o error, write)`);
    expect(exit).toHaveBeenLastCalledWith(1);
    expect(crashBytes()).toBe(before);
  });

  it.each([
    ['a maintenance refusal while the gate is closed', () => { closeMaintenanceGate('hook', 'm'); return new DataBackendUnavailableError('maintenance'); }, false],
    ['an error during the exit drain', () => { h.draining = true; return thrownHere(); }, false],
  ])('262: guardUncaught returns early (%s): no count', (_name, make, exits) => {
    const error = make();
    crashIn(opened('m262', 'S262'), error);
    expect(crashBytes()).toBeNull();
    expect(exit.mock.calls.length > 0).toBe(exits);
  });

  it('a long message is cut to 300 characters; a value that is not an Error is written as text', () => {
    crashIn(opened('m-long', 'L1'), thrownHere('x'.repeat(400)));
    expect(crashLines()['m-long'].error).toBe('x'.repeat(300));
    crashIn(opened('m-text', 'T1'), 'a plain string');
    expect(crashLines()['m-text']).toMatchObject({ sha: 'T1', n: 1, error: 'a plain string' });
  });

  it("a count of another sha starts again at 1", () => {
    crashIn(opened('m-two', 'A1'));
    crashIn(openStarts.get('m-two')!);
    expect(crashLines()['m-two']).toMatchObject({ sha: 'A1', n: 2 });
    _resetModuleCrashes();
    crashIn(opened('m-two', 'A2'));
    expect(crashLines()['m-two']).toMatchObject({ sha: 'A2', n: 1 });
  });
});

describe('the pick (100)', () => {
  it('299: starting empty, one late start with a sha and a frame of the stack under its dir: counted against it', () => {
    const q = opened('q299', 'Q1');
    markLate(q);
    guardUncaught(thrownIn('q299'));
    expect(crashLines()).toEqual({ q299: expect.objectContaining({ sha: 'Q1', n: 1, error: 'q299 broke' }) });
  });

  it.each([
    ['no late start', () => { opened('q300', 'Q1'); return thrownIn('q300'); }],
    ['two late starts', () => { markLate(opened('q300', 'Q1')); markLate(opened('r300', 'R1')); return thrownIn('q300'); }],
    ['the one late start has a null sha', () => { markLate(opened('q300', null)); return thrownIn('q300'); }],
    ['no frame under its dir', () => { markLate(opened('q300', 'Q1')); moduleDir('p300'); return thrownIn('p300'); }],
  ])('300: %s: no count', (_name, setup) => {
    guardUncaught(setup());
    expect(crashBytes()).toBeNull();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("330: a late start's own throw is counted against its sha at two crashes, n 1 then 2", () => {
    const u = opened('u330', 'TO');
    markLate(u);
    guardUncaught(thrownIn('u330'));
    expect(crashLines()['u330']).toMatchObject({ sha: 'TO', n: 1 });
    guardUncaught(thrownIn('u330'));
    expect(crashLines()['u330']).toMatchObject({ sha: 'TO', n: 2 });
  });

  it("331: a version in place whose initializer throws after its 60 s turn, at two boots: n 1 then 2", () => {
    markLate(opened('v331', 'IN', { boot: true }));
    guardUncaught(thrownIn('v331'));
    expect(crashLines()['v331']).toMatchObject({ sha: 'IN', n: 1 });
    _resetModuleCrashes();
    markLate(opened('v331', 'IN', { boot: true }));
    guardUncaught(thrownIn('v331'));
    expect(crashLines()['v331']).toMatchObject({ sha: 'IN', n: 2 });
  });

  it('332: starting names a module with no entry while one App Store start is late: no count', () => {
    markLate(opened('q332', 'Q1'));
    crashIn(opened('local332', null), thrownIn('q332'));
    expect(crashBytes()).toBeNull();
  });

  it('333: two late starts, one with a null sha: no count', () => {
    markLate(opened('q333', 'Q1'));
    markLate(opened('n333', null));
    guardUncaught(thrownIn('q333'));
    expect(crashBytes()).toBeNull();
  });

  it("338: a reload's start holds starting over its window; a crash in it is counted; its end deletes the line", async () => {
    const r = opened('r338', 'R1');
    crashIn(r);
    expect(crashLines()['r338']).toMatchObject({ sha: 'R1', n: 1 });
    await endStart(r, 'ok');
    expect(crashLines()['r338']).toBeUndefined();
    expect(openStarts.has('r338')).toBe(false);
  });

  it('370: one late start Q, a stack with no frame under its dir (module P\'s handler): no count', () => {
    markLate(opened('q370', 'Q1'));
    moduleDir('p370');
    guardUncaught(thrownIn('p370'));
    expect(crashBytes()).toBeNull();
  });

  it("371: a function Q exports, called by P, throws: Q's frame is on the stack and Q is counted", () => {
    markLate(opened('q371', 'Q1'));
    const p = moduleDir('p371');
    const q = nodeRequire(path.join(dirOf('q371'), 'index.js'));
    let error: unknown;
    try {
      p.call(() => q.boom('Q threw for P'));
    } catch (e) {
      error = e;
    }
    guardUncaught(error);
    expect(crashLines()['q371']).toMatchObject({ sha: 'Q1', n: 1, error: 'Q threw for P' });
  });

  it.each([
    ['a value that is not an Error', () => ({ message: 'not an error' })],
    ['a stack with no file frame', () => Object.assign(new Error('no frames'), { stack: 'Error: no frames\n    at <anonymous>' })],
  ])('372: %s: no count', (_name, make) => {
    markLate(opened('q372', 'Q1'));
    guardUncaught(make());
    expect(crashBytes()).toBeNull();
  });

  it('373: two windows open (a dev reload of B during U\'s window): no count', () => {
    const u = opened('u373', 'U1');
    const b = opened('b373', 'B1');
    openWindow(u);
    openWindow(b);
    guardUncaught(thrownIn('u373'));
    closeWindow(b);
    closeWindow(u);
    expect(crashBytes()).toBeNull();
  });

  it("374: B's window closed while U's stays open, then an uncaught error: counted against U", () => {
    const u = opened('u374', 'U1');
    const b = opened('b374', 'B1');
    openWindow(u);
    openWindow(b);
    closeWindow(b);
    guardUncaught(thrownHere());
    closeWindow(u);
    expect(crashLines()).toEqual({ u374: expect.objectContaining({ sha: 'U1', n: 1 }) });
  });
});

describe('frameUnder (100)', () => {
  it('a frame in the "(file:line:column)" form and the "at file:line:column" form', () => {
    const dir = path.join(tmp, 'fq');
    const file = path.join(dir, 'lib', 'a.js');
    expect(frameUnder({ stack: `Error: x\n    at f (${file}:3:9)` }, dir)).toBe(true);
    expect(frameUnder({ stack: `Error: x\n    at ${file}:3:9` }, dir)).toBe(true);
    expect(frameUnder({ stack: `Error: x\n    at f (${path.join(tmp, 'fq-other', 'a.js')}:3:9)` }, dir)).toBe(false);
    expect(frameUnder({ stack: `Error: x\n    at f (${dir}:3:9)` }, dir)).toBe(false);
  });

  it('a "file://" frame is read as its path', () => {
    const dir = path.join(tmp, 'fu');
    const url = pathToFileURL(path.join(dir, 'b.mjs')).href;
    expect(frameUnder({ stack: `Error: x\n    at f (${url}:1:1)` }, dir)).toBe(true);
    expect(frameUnder({ stack: `Error: x\n    at ${url}:1:1` }, dir)).toBe(true);
  });

  it('the first line is the message, never a frame', () => {
    const dir = path.join(tmp, 'fm');
    expect(frameUnder({ stack: `Error: at f (${path.join(dir, 'a.js')}:1:1)\n    at <anonymous>` }, dir)).toBe(false);
  });

  it('no file frame, a stack that is not a string, or a value that is not an object: false', () => {
    const dir = path.join(tmp, 'fn');
    expect(frameUnder({ stack: 'Error: x\n    at <anonymous>\n    at new Promise (<anonymous>)' }, dir)).toBe(false);
    expect(frameUnder({ stack: 42 }, dir)).toBe(false);
    expect(frameUnder('Error: x', dir)).toBe(false);
    expect(frameUnder(null, dir)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('a Windows path is compared in lower case', () => {
    const dir = path.join(tmp, 'Fw');
    const file = path.join(dir, 'Lib', 'a.js').toUpperCase();
    expect(frameUnder({ stack: `Error: x\n    at f (${file}:3:9)` }, dir.toLowerCase())).toBe(true);
    expect(frameUnder({ stack: `Error: x\n    at f (${pathToFileURL(path.join(dir, 'a.js')).href}:3:9)` }, dir)).toBe(true);
  });
});

describe('a line whose delete failed (107)', () => {
  it("358: endStart's crash-line write throws: 66's line; keptEnds holds M and S; the end goes on to onStartEnded", async () => {
    const start = opened('m358', 'S358');
    crashIn(start);
    const ended: unknown[] = [];
    removeEndListeners.push(onStartEnded((s, result) => { ended.push([s.module, result]); }));
    h.failCrashWrites = 1;
    await endStart(start, 'ok');
    expect(errors).toContain(`${COUNT_LINE} (EIO: i/o error, write)`);
    expect(keptEnds.get('m358')).toBe('S358');
    expect(ended).toEqual([['m358', 'ok']]);
    expect(crashLines()['m358']).toMatchObject({ sha: 'S358', n: 1 });
  });

  it("358: endStart's crash-line read throws: the same", async () => {
    const start = opened('m358r', 'S358');
    fs.mkdirSync(CRASH_FILE, { recursive: true });
    await endStart(start, 'ok');
    expect(errors.some(e => e.startsWith(`${COUNT_LINE} (`))).toBe(true);
    expect(keptEnds.get('m358r')).toBe('S358');
  });

  it('387: after 358, a count of that sha writes n 1, not 2, and deletes the entry', async () => {
    await keptAfter358('m387', 'S387');
    crashIn(opened('m387', 'S387'));
    expect(crashLines()['m387']).toMatchObject({ sha: 'S387', n: 1 });
    expect(keptEnds.has('m387')).toBe(false);
  });

  it('388: after 387, a second count of that sha with no end between writes n 2', async () => {
    await keptAfter358('m388', 'S388');
    const start = opened('m388', 'S388');
    crashIn(start);
    crashIn(start);
    expect(crashLines()['m388']).toMatchObject({ sha: 'S388', n: 2 });
  });

  it("389: after 358, a later end whose line delete succeeds deletes the entry; the next counts follow 66's rule", async () => {
    await keptAfter358('m389', 'S389');
    await endStart(opened('m389', 'S389'), 'ok');
    expect(keptEnds.has('m389')).toBe(false);
    expect(crashLines()['m389']).toBeUndefined();
    const start = opened('m389', 'S389');
    crashIn(start);
    crashIn(start);
    expect(crashLines()['m389']).toMatchObject({ sha: 'S389', n: 2 });
  });

  it("after 358, an end of another sha of the module deletes no line and deletes the entry", async () => {
    await keptAfter358('m-other', 'S1');
    const writes = h.crashWrites;
    await endStart(opened('m-other', 'S2'), 'ok');
    expect(h.crashWrites).toBe(writes);
    expect(keptEnds.has('m-other')).toBe(false);
    expect(crashLines()['m-other']).toMatchObject({ sha: 'S1', n: 1 });
  });
});

describe('the exit retry (112)', () => {
  it("403: after 358, the process ends through guardUncaught while another module's start is counted: the retry removes M's line", async () => {
    await keptAfter358('m403', 'S403');
    expect(armedRetry()).toBe(retryKeptEnds);
    crashIn(opened('n403', 'N1'));
    armedRetry()!(1);
    expect(crashLines()).toEqual({ n403: expect.objectContaining({ sha: 'N1', n: 1 }) });
    expect(keptEnds.has('m403')).toBe(false);
  });

  it('403: the same with no start counted', async () => {
    await keptAfter358('m403b', 'S403');
    guardUncaught(thrownHere());
    armedRetry()!(1);
    expect(crashLines()).toEqual({});
    expect(keptEnds.size).toBe(0);
  });

  it("404: after 358 for two modules, the stop handler's exit: both lines removed by one write, both entries deleted", async () => {
    await keptAfter358('m404a', 'A');
    await keptAfter358('m404b', 'B');
    expect(process.listeners('exit').filter(l => l === retryKeptEnds)).toHaveLength(1);
    const writes = h.crashWrites;
    armedRetry()!(0);
    expect(h.crashWrites).toBe(writes + 1);
    expect(crashLines()).toEqual({});
    expect(keptEnds.size).toBe(0);
  });

  it("405: after 358, starting holds M's start of S at guardUncaught: n 1, the entry deleted, the retry leaves the line", async () => {
    await keptAfter358('m405', 'S405');
    crashIn(opened('m405', 'S405'));
    expect(keptEnds.has('m405')).toBe(false);
    const writes = h.crashWrites;
    armedRetry()!(1);
    expect(h.crashWrites).toBe(writes);
    expect(crashLines()['m405']).toMatchObject({ sha: 'S405', n: 1 });
  });

  it.each([
    ['names another sha', (lines: Record<string, { sha: string }>) => { lines.m406.sha = 'OTHER'; }],
    ['is gone', (lines: Record<string, { sha: string }>) => { delete lines.m406; }],
  ])("406: after 358, M's line %s (a later writer of the file): the entry deleted, the file not written", async (_name, change) => {
    await keptAfter358('m406', 'S406');
    const lines = crashLines();
    change(lines);
    fs.writeFileSync(CRASH_FILE, JSON.stringify(lines));
    const before = crashBytes();
    const writes = h.crashWrites;
    armedRetry()!(0);
    expect(h.crashWrites).toBe(writes);
    expect(crashBytes()).toBe(before);
    expect(keptEnds.has('m406')).toBe(false);
  });

  it("407: the retry's write throws: the line and the entry stay; 66's line", async () => {
    await keptAfter358('m407', 'S407');
    const before = crashBytes();
    errors.length = 0;
    h.failCrashWrites = 1;
    armedRetry()!(0);
    expect(errors).toEqual([`${COUNT_LINE} (EIO: i/o error, write)`]);
    expect(keptEnds.get('m407')).toBe('S407');
    expect(crashBytes()).toBe(before);
  });

  it("407: the retry's read throws: the entry stays; 66's line", async () => {
    await keptAfter358('m407r', 'S407');
    fs.rmSync(CRASH_FILE);
    fs.mkdirSync(CRASH_FILE);
    errors.length = 0;
    armedRetry()!(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`${COUNT_LINE} (`)).toBe(true);
    expect(keptEnds.get('m407r')).toBe('S407');
  });

  it('408: keptEnds emptied after the retry was armed (387): nothing read or written', async () => {
    await keptAfter358('m408', 'S408');
    crashIn(opened('m408', 'S408'));
    expect(keptEnds.size).toBe(0);
    fs.rmSync(CRASH_FILE);
    fs.mkdirSync(CRASH_FILE);
    errors.length = 0;
    const writes = h.crashWrites;
    armedRetry()!(0);
    expect(errors).toEqual([]);
    expect(h.crashWrites).toBe(writes);
  });

  it('409: a start of M ends during the exit drain and its delete throws: the retry is armed and removes the line at exit', async () => {
    const start = opened('m409', 'S409');
    crashIn(start);
    expect(armedRetry()).toBeUndefined();
    h.draining = true;
    h.failCrashWrites = 1;
    await endStart(start, 'ok');
    expect(errors).toContain(`${COUNT_LINE} (EIO: i/o error, write)`);
    expect(armedRetry()).toBe(retryKeptEnds);
    armedRetry()!(0);
    expect(crashLines()['m409']).toBeUndefined();
    expect(keptEnds.size).toBe(0);
  });

  it('an end that keeps no line arms no exit listener', async () => {
    const start = opened('m-none', 'S');
    crashIn(start);
    await endStart(start, 'ok');
    expect(armedRetry()).toBeUndefined();
  });
});

describe('after a deposition (114)', () => {
  const role = process.env.BOT_PROCESS_ROLE;

  beforeEach(() => {
    freshWriterLock('bot', new Set([process.pid, OTHER]));
  });

  afterEach(() => {
    vi.useRealTimers();
    while (writerLockDepth() > 0) releaseWriterLock();
    fs.rmSync(writerLockPath(), { force: true });
    takeWriterLock();
    while (writerLockDepth() > 0) releaseWriterLock();
    fs.rmSync(writerLockPath(), { force: true });
    freshWriterLock('webui');
    reopenSharedWrites();
    if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
    else process.env.BOT_PROCESS_ROLE = role;
  });

  /** NB10's deposition through the writer lock's own 5 s check: the lock file now names another live process. */
  function deposed(): void {
    vi.useFakeTimers();
    expect(takeWriterLock()).toMatchObject({ kind: 'taken' });
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
    vi.advanceTimersByTime(5_100);
    vi.useRealTimers();
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
  }

  const STOPPED = `${COUNT_LINE} (another process took the data files)`;

  it.each([
    ['416: guardUncaught with starting set: nothing written, the crash not counted, the exit goes on', async () => {
      crashIn(opened('m416', 'S416'));
      const before = crashBytes();
      deposed();
      crashIn(openStarts.get('m416')!);
      expect(exit).toHaveBeenLastCalledWith(1);
      return before;
    }],
    ["417: a start of M of sha S ends 'ok' while M's line names S: the line stays, keptEnds unchanged, no listener", async () => {
      const start = opened('m417', 'S417');
      crashIn(start);
      const before = crashBytes();
      deposed();
      await endStart(start, 'ok');
      expect(keptEnds.has('m417')).toBe(false);
      expect(armedRetry()).toBeUndefined();
      expect(openStarts.has('m417')).toBe(false);
      return before;
    }],
    ['418: keptEnds holds M and S from 358 before the deposition; the stop handler exits with 75: nothing written', async () => {
      await keptAfter358('m418', 'S418');
      const before = crashBytes();
      deposed();
      armedRetry()!(75);
      expect(keptEnds.get('m418')).toBe('S418');
      return before;
    }],
  ])('%s', async (_name, row) => {
    const before = await row();
    expect(crashBytes()).toBe(before);
    expect(errors).toContain(STOPPED);
  });
});

// Part 16: the boot rule (66 as 80 amends it), 49 step 7 (80) and the apply half of row 126, over versions the real apply
// put in place and crash lines `countCrash` wrote through `guardUncaught`.
describe('the boot rule and 49 step 7 (part 16)', () => {
  const rig = applyRig();
  const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
  const T_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n', 'fail.txt': 'index.js threw: boom' };
  const U_FILES = { 'module.json': '{"name":"m","version":"3.0.0"}', 'index.js': 'exports.v = 3;\n' };

  class Killed extends Error {}

  beforeEach(async () => {
    await rig.setup();
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => rig.teardown());

  const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

  /** One process whose start of the module's sha stopped the bot through guardUncaught while its window was open. */
  function crashedStart(module: string, sha: string, version: string, message: string): void {
    _resetModuleCrashes();
    const start = startModule(module, sha, version, path.join(rig.state.source, module), { boot: true });
    if (typeof start === 'string') throw new Error(start);
    openWindow(start);
    guardUncaught(new Error(message));
    closeWindow(start);
    _resetModuleCrashes();
  }

  it('257: a version in place whose line reached 2: heldSha (failedSha unchanged), a failed status, T1 in-place once; its boot start is skipped', async () => {
    const s = await rig.inPlace('m', S_FILES);
    crashedStart('m', s, '1.0.0', 'first stop');
    crashedStart('m', s, '1.0.0', 'second stop');
    rig.state.lines.length = 0;
    recoverModuleApplies();
    recoverModuleApplies();
    expect(rig.entry('m')).toMatchObject({ sha: s, heldSha: s, failedSha: null, status: { state: 'failed', sha: s, error: 'the bot stopped twice while it was starting it (second stop)' } });
    expect(shared()).toEqual(['[Shared] The bot stopped twice while it was starting m 1.0.0 on this machine (the error at the second stop: second stop); this machine does not load m until it is updated, or uninstalled and installed again']);
    expect(onModuleCode({ name: 'm', path: path.join(rig.state.source, 'm'), version: '1.0.0' })).toBe('skip');
    expect(rig.live('m')).toEqual(S_FILES);
    await rig.pass();
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: s })]);
  });

  it("258: step 7 deletes a line whose sha is none of the row's, the entry's and applying.to; the entry's line stays", async () => {
    const s = await rig.inPlace('m', S_FILES);
    crashedStart('m', s, '1.0.0', 'kept');
    crashedStart('gone', 'G0', '1.0.0', 'no row, no entry');
    await rig.publish('other', { 'index.js': 'other' });
    crashedStart('other', 'O1', '1.0.0', 'another sha');
    await rig.pass();
    const lines = JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8'));
    expect(Object.keys(lines).sort()).toEqual(['m']);
    expect(lines.m).toMatchObject({ sha: s, n: 1 });
  });

  it("302 and 303: S kept after T failed (failedSha T): step 7 keeps S's line; at n 2 S is held, failedSha T kept, and the pass applies nothing while the row names T", async () => {
    const s = await rig.inPlace('m', S_FILES);
    const t = await rig.publish('m', T_FILES, '2.0.0');
    await rig.apply('m', t);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: t });
    crashedStart('m', s, '1.0.0', 'first stop');
    await rig.pass();
    expect(JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8')).m).toMatchObject({ sha: s, n: 1 });
    crashedStart('m', s, '1.0.0', 'second stop');
    rig.state.lines.length = 0;
    recoverModuleApplies();
    expect(rig.entry('m')).toMatchObject({ sha: s, heldSha: s, failedSha: t });
    expect(shared()).toEqual(['[Shared] The bot stopped twice while it was starting m 1.0.0 on this machine (the error at the second stop: second stop); this machine does not load m until it is updated, or uninstalled and installed again']);
    fakeLoader.loads = [];
    await rig.pass();
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.live('m')).toEqual(S_FILES);
  });

  it('126 (the apply half): a crash in the load window of an apply is counted against to; the next boot puts S back with the once-more tail; a second one holds to back', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '3.0.0');
    const crashInLoad = () => {
      fakeLoader.duringLoad = module => {
        const start = startModule(module, startShaOf(module), '3.0.0', path.join(rig.state.source, module));
        if (typeof start === 'string') throw new Error(start);
        openWindow(start);
        guardUncaught(new Error('the new version threw while it loaded'));
        throw new Killed('the process ended');
      };
    };
    crashInLoad();
    await expect(rig.apply('m', u)).rejects.toThrow(Killed);
    _resetModuleCrashes();
    expect(JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8')).m).toMatchObject({ sha: u, n: 1 });
    rig.state.lines.length = 0;
    recoverModuleApplies();
    expect(shared()).toEqual([expect.stringMatching(/^\[Shared\] m: applying 3\.0\.0 was cut off when the bot stopped while it was starting 3\.0\.0; put back the previous version from .+\. This machine applies the database's current version of m again at this start; if the bot stops again while starting 3\.0\.0, this machine keeps the previous version\.$/)]);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: null });

    crashInLoad();
    await expect(rig.apply('m', u)).rejects.toThrow(Killed);
    _resetModuleCrashes();
    fakeLoader.duringLoad = null;
    expect(JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8')).m).toMatchObject({ sha: u, n: 2 });
    rig.state.lines.length = 0;
    recoverModuleApplies();
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u, status: { state: 'failed', sha: u, error: 'the bot stopped twice while it was starting it (the new version threw while it loaded)' } });
    expect(shared()).toEqual([
      expect.stringMatching(/^\[Shared\] m: applying 3\.0\.0 was cut off when the bot stopped while it was starting 3\.0\.0; put back the previous version from \S+$/),
      '[Shared] The bot stopped twice while it was starting m 3.0.0 on this machine (the error at the second stop: the new version threw while it loaded); this machine keeps the previous version and does not try 3.0.0 again until m is updated, or uninstalled and installed again',
    ]);
    fakeLoader.loads = [];
    await rig.pass();
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.live('m')).toEqual(S_FILES);
  });

  describe('419: a pass in flight at the deposition', () => {
    const role = process.env.BOT_PROCESS_ROLE;

    beforeEach(() => {
      freshWriterLock('bot', new Set([process.pid, OTHER]));
    });

    afterEach(() => {
      vi.useRealTimers();
      while (writerLockDepth() > 0) releaseWriterLock();
      fs.rmSync(writerLockPath(), { force: true });
      takeWriterLock();
      while (writerLockDepth() > 0) releaseWriterLock();
      fs.rmSync(writerLockPath(), { force: true });
      freshWriterLock('webui');
      reopenSharedWrites();
      if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
      else process.env.BOT_PROCESS_ROLE = role;
    });

    it("reaches step 7 with a line to delete: nothing is written, the line stays, 66's line with that cause", async () => {
      crashedStart('gone', 'G0', '1.0.0', 'no row, no entry');
      const before = crashBytes();
      vi.useFakeTimers();
      expect(takeWriterLock()).toMatchObject({ kind: 'taken' });
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
      vi.advanceTimersByTime(5_100);
      vi.useRealTimers();
      expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
      await rig.pass();
      expect(crashBytes()).toBe(before);
      expect(rig.state.lines).toContain(`${COUNT_LINE} (another process took the data files)`);
    });
  });
});
