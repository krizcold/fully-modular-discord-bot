import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { applyRig, fakeLoader, noFile, ownError, reloaderFakes } from '../helpers/nb6ApplyRig';
import { readStoreRecord, writeStoreRecord, type ModuleEntry } from '../../src/bot/internalSetup/utils/sharedRecords';
import {
  BOOT_COMPILE_MS, _setModuleDirs, beginBootApplies, bootCompileModules, builtCurrent,
} from '../../src/bot/internalSetup/utils/moduleApply';
import type { CompileResult } from '../../src/bot/internalSetup/utils/moduleReloader';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const NO_VERSION = { 'module.json': '{"name":"m"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const BOUND_TEXT = 'it did not finish within 10 minutes';
const fakes = { ...reloaderFakes };

beforeEach(() => rig.setup());
afterEach(async () => {
  Object.assign(reloaderFakes, fakes);
  await rig.teardown();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));
const errors = () => rig.state.lines.filter(l => l.startsWith('[Error]'));
const buildFile = () => path.join(rig.state.root, 'dist', '.build-complete');
const newBuild = (id = 'image-2') => fs.writeFileSync(buildFile(), id);

function compileWith(run: () => CompileResult): void {
  reloaderFakes.recompileTypeScript = async () => {
    fakeLoader.compileCalls += 1;
    return run();
  };
}

function dropEntry(module: string): void {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  delete read.record.modules[module];
  writeStoreRecord(read.record);
}

describe('builtCurrent', () => {
  it('rl8 built sha: a build of another sha in this image is not current', () => {
    newBuild('image-1');
    const entry = { sha: 's2', built: { sha: 's1', buildId: 'image-1' } } as unknown as ModuleEntry;
    expect(builtCurrent(entry)).toBe(false);
    expect(builtCurrent({ ...entry, built: { sha: 's2', buildId: 'image-1' } })).toBe(true);
  });
});

describe('a boot compile that ran for the whole bound', () => {
  async function staleModule(): Promise<void> {
    await rig.inPlace('m', S_FILES);
    newBuild();
    vi.useFakeTimers({ toFake: ['Date'] });
  }

  it('rl8 bound at 600 s: a compile failing with no file after exactly 600 s is logged with the bound text', async () => {
    await staleModule();
    compileWith(() => {
      vi.setSystemTime(Date.now() + BOOT_COMPILE_MS);
      return noFile();
    });
    await bootCompileModules();
    expect(shared()).toContain(`[Shared] The boot compile of App Store modules failed (${BOUND_TEXT})`);
    expect(shared()).toContain(`[Shared] m 1.0.0 could not be compiled on this machine at this start (${BOUND_TEXT}); this machine does not load it, and compiles it again at the next start`);
  });

  it('rl8 bound before 600 s: a compile failing with no file a millisecond sooner keeps its own error', async () => {
    await staleModule();
    compileWith(() => {
      vi.setSystemTime(Date.now() + BOOT_COMPILE_MS - 1);
      return noFile();
    });
    await bootCompileModules();
    expect(shared()).toContain('[Shared] The boot compile of App Store modules failed (Command failed: tsc (killed))');
  });

  it('rl8 bound timer: a compile that answers leaves no 10 minute timer behind', async () => {
    await rig.inPlace('m', S_FILES);
    newBuild();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const before = vi.getTimerCount();
    await bootCompileModules();
    expect(rig.entry('m')?.built).toMatchObject({ buildId: 'image-2' });
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe('an entry removed while the boot compile ran', () => {
  it('rl8 not compiled gone: a compile with no file names the module with no version and writes no entry', async () => {
    await rig.inPlace('m', NO_VERSION);
    newBuild();
    compileWith(() => {
      dropEntry('m');
      return noFile();
    });
    await bootCompileModules();
    expect(shared()).toContain('[Shared] m  could not be compiled on this machine at this start (Command failed: tsc (killed)); this machine does not load it, and compiles it again at the next start');
    expect(errors()).toEqual([]);
    expect(rig.entry('m')).toBeUndefined();
  });

  it("rl8 own errors gone: a compile failing in the module's files logs T19 with no version and writes no entry", async () => {
    await rig.inPlace('m', NO_VERSION);
    newBuild();
    compileWith(() => {
      dropEntry('m');
      return ownError('m');
    });
    await bootCompileModules();
    expect(shared()).toContain("[Shared] m  does not compile with this bot's version (build/bot/modules/m/index.ts:3 Type 'string' is not assignable to type 'number'.; 1 errors in its files); this machine does not load it until it is updated or the bot's version changes");
    expect(errors()).toEqual([]);
    expect(rig.entry('m')).toBeUndefined();
  });
});

describe('development, one folder for source, build and dist', () => {
  it('rl8 dev keep: a boot compile with no file keeps the live folder', async () => {
    const dir = rig.state.dist;
    _setModuleDirs({ source: dir, build: dir, dist: dir, backups: rig.state.backups, buildFile: buildFile() });
    fakeLoader.source = dir;
    await rig.inPlace('m', S_FILES);
    newBuild();
    compileWith(() => noFile());
    await bootCompileModules();
    expect(shared().some(l => l.startsWith('[Shared] m 1.0.0 could not be compiled on this machine at this start'))).toBe(true);
    expect(rig.readTree(path.join(dir, 'm'))).toEqual(S_FILES);
  });
});

describe('the modules this boot swapped', () => {
  async function bootSwap(): Promise<void> {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    beginBootApplies();
    const result = await rig.apply('m', u);
    expect(result.outcome).toBe('loaded');
    expect(rig.entry('m')?.applying).toMatchObject({ to: u });
  }

  it('rl8 swap entry gone: a swapped module whose entry is gone runs no compile', async () => {
    await bootSwap();
    dropEntry('m');
    const calls = fakeLoader.compileCalls;
    await expect(bootCompileModules()).resolves.toBeUndefined();
    expect(fakeLoader.compileCalls).toBe(calls);
  });

  it('rl8 swap intent cleared: a swapped module whose entry no longer holds the intent runs no compile', async () => {
    await bootSwap();
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    read.record.modules.m = { ...read.record.modules.m, applying: null, built: { sha: read.record.modules.m.sha, buildId: null } };
    writeStoreRecord(read.record);
    const calls = fakeLoader.compileCalls;
    await bootCompileModules();
    expect(fakeLoader.compileCalls).toBe(calls);
    expect(rig.entry('m')?.status ?? null).toBeNull();
  });

  it('rl8 boot again: a second beginBootApplies forgets the swaps of the first, so the compile does not run for them', async () => {
    await bootSwap();
    beginBootApplies();
    const calls = fakeLoader.compileCalls;
    await bootCompileModules();
    expect(fakeLoader.compileCalls).toBe(calls);
  });
});

describe("NB45: tsc's incremental record at the boot", () => {
  const TS_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'commands/ping.ts': 'export default { name: "ping" };\n', 'types.d.ts': 'export {};\n' };
  const record = () => path.join(rig.state.root, 'dist', '.tsbuildinfo');

  it("nb45 boot T2: a compile with no file deletes the record with the module's dist folder", async () => {
    await rig.inPlace('m', S_FILES);
    newBuild();
    rig.writeTree(path.join(rig.state.dist, 'm'), { 'index.js': 'compiled' });
    fs.writeFileSync(record(), '{}');
    compileWith(() => noFile());
    await bootCompileModules();
    expect(rig.dist('m')).toBeNull();
    expect(fs.existsSync(record())).toBe(false);
  });

  it("nb45 boot empty: an entry built in this image whose dist folder lacks a .js of its .ts files is compiled again, the record deleted first", async () => {
    await rig.inPlace('m', TS_FILES);
    expect(builtCurrent(rig.entry('m')!)).toBe(true);
    fs.writeFileSync(record(), '{}');
    let recordAtCompile: boolean | null = null;
    compileWith(() => {
      recordAtCompile = fs.existsSync(record());
      rig.writeTree(path.join(rig.state.dist, 'm'), { 'commands/ping.js': 'compiled' });
      return { success: true, duration: 0, diagnostics: [] };
    });
    const calls = fakeLoader.compileCalls;
    await bootCompileModules();
    expect(fakeLoader.compileCalls).toBe(calls + 1);
    expect(recordAtCompile).toBe(false);
    expect(builtCurrent(rig.entry('m')!)).toBe(true);
  });

  it('nb45 boot whole: an entry built in this image whose dist folder holds every .js is not compiled, and the record stays', async () => {
    await rig.inPlace('m', TS_FILES);
    rig.writeTree(path.join(rig.state.dist, 'm'), { 'commands/ping.js': 'compiled' });
    fs.writeFileSync(record(), '{}');
    const calls = fakeLoader.compileCalls;
    await bootCompileModules();
    expect(fakeLoader.compileCalls).toBe(calls);
    expect(fs.existsSync(record())).toBe(true);
  });

  it("nb45 boot skipped: the .ts files tsc's ** skips (node_modules, dot-named) are not looked for in the dist folder", async () => {
    await rig.inPlace('m', TS_FILES);
    rig.writeTree(path.join(rig.state.source, 'm'), { 'node_modules/dep/index.ts': 'export {};\n', '.hidden.ts': 'export {};\n', '.cache/x.ts': 'export {};\n' });
    rig.writeTree(path.join(rig.state.dist, 'm'), { 'commands/ping.js': 'compiled' });
    fs.writeFileSync(record(), '{}');
    const calls = fakeLoader.compileCalls;
    await bootCompileModules();
    expect(fakeLoader.compileCalls).toBe(calls);
    expect(fs.existsSync(record())).toBe(true);
  });
});

describe('a module of the store with no source folder', () => {
  it('rl8 no folder: it is not compiled and its entry is left as it was', async () => {
    await rig.inPlace('m', S_FILES);
    newBuild();
    fs.rmSync(path.join(rig.state.source, 'm'), { recursive: true, force: true });
    const before = rig.entry('m');
    const calls = fakeLoader.compileCalls;
    await bootCompileModules();
    expect(fakeLoader.compileCalls).toBe(calls);
    expect(rig.entry('m')).toEqual(before);
  });
});
