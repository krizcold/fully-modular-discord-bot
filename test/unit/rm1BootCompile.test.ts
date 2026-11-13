import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import type { Client } from 'discord.js';
import { applyRig, fakeLoader, noFile, otherError, ownError, reloaderFakes } from '../helpers/nb6ApplyRig';
import { readStoreRecord, storeRecordPath, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { _setModuleDirs, beginBootApplies, bootCompileModules, bootLoadCheck } from '../../src/bot/internalSetup/utils/moduleApply';
import { onModuleCode } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { clearLoadFailures } from '../../src/bot/internalSetup/utils/loadFailures';
import type { CompileResult } from '../../src/bot/internalSetup/utils/moduleReloader';

const rig = applyRig();
const files = (name: string, version: string, v: number) => ({ 'module.json': `{"name":"${name}","version":"${version}"}`, 'index.js': `exports.v = ${v};\n` });
const M1 = files('m', '1.0.0', 1);
const M2 = files('m', '2.0.0', 2);
const N1 = files('n', '1.0.0', 1);
const N2 = files('n', '2.0.0', 2);
const fakes = { ...reloaderFakes };
const OWN_M = "build/bot/modules/m/index.ts:3 Type 'string' is not assignable to type 'number'.";

beforeEach(() => rig.setup());
afterEach(async () => {
  Object.assign(reloaderFakes, fakes);
  clearLoadFailures();
  await rig.teardown();
});

const lines = () => rig.state.lines;
const linesOf = (module: string) => lines().filter(l => l.startsWith(`[Shared] ${module} `));
const newBuild = (id = 'image-2') => fs.writeFileSync(path.join(rig.state.root, 'dist', '.build-complete'), id);
const breakRecord = () => fs.writeFileSync(storeRecordPath(), 'not a record');

function compiles(...steps: Array<() => CompileResult>): void {
  reloaderFakes.recompileTypeScript = async () => {
    fakeLoader.compileCalls += 1;
    const step = steps.shift();
    return step ? step() : { success: true, duration: 0, diagnostics: [] };
  };
}

async function bootSwap(module: string, to: string): Promise<void> {
  beginBootApplies();
  const result = await rig.apply(module, to);
  expect(result.outcome).toBe('loaded');
  expect(rig.entry(module)?.applying).toMatchObject({ to });
}

/** m 1.0.0 in place, then 2.0.0 swapped in by this boot's pass. */
async function bootUpdate(): Promise<{ s: string; u: string }> {
  const s = await rig.inPlace('m', M1);
  const u = await rig.publish('m', M2, '2.0.0');
  await bootSwap('m', u);
  lines().length = 0;
  return { s, u };
}

describe('the modules the boot judges', () => {
  it('rm1 applying elsewhere: a module whose entry holds an apply this boot did not swap is not judged or compiled', async () => {
    await rig.inPlace('m', M1);
    const u = await rig.publish('m', M2, '2.0.0');
    await bootSwap('m', u);
    beginBootApplies();
    newBuild();
    const before = rig.entry('m');
    const calls = fakeLoader.compileCalls;
    await bootCompileModules();
    expect(fakeLoader.compileCalls).toBe(calls);
    expect(rig.entry('m')).toEqual(before);
  });

  it('rm1 no error text: a compile with no file and no error names "the compile failed" in both lines', async () => {
    await rig.inPlace('m', M1);
    newBuild();
    compiles(() => ({ success: false, duration: 0, diagnostics: [] }));
    await bootCompileModules();
    expect(lines()).toContain('[Shared] The boot compile of App Store modules failed (the compile failed)');
    expect(lines()).toContain('[Shared] m 1.0.0 could not be compiled on this machine at this start (the compile failed); this machine does not load it, and compiles it again at the next start');
  });

  it('rm1 clean compile: a compile that succeeds logs no failed boot compile', async () => {
    await rig.inPlace('m', M1);
    newBuild();
    await bootCompileModules();
    expect(lines().filter(l => l.startsWith('[Shared] The boot compile'))).toEqual([]);
    expect(rig.entry('m')?.built).toMatchObject({ buildId: 'image-2' });
  });

  it("rm1 other's errors: a compile failing only in another module's files writes the module built", async () => {
    const s = await rig.inPlace('m', M1);
    newBuild();
    compiles(otherError);
    await bootCompileModules();
    expect(rig.entry('m')?.built).toEqual({ sha: s, buildId: 'image-2' });
    expect(lines().filter(l => l.includes('does not compile'))).toEqual([]);
  });

  it('rm1 copy failed: a module whose copy into the build folder failed is left out of the boot load', async () => {
    await rig.inPlace('m', M1);
    newBuild();
    const build = path.resolve(rig.state.build, 'm');
    const real = fs.cpSync;
    vi.spyOn(fs, 'cpSync').mockImplementation(((from: string, to: string, opts?: fs.CopySyncOptions) => {
      if (path.resolve(String(to)) === build) throw new Error('disk full');
      return real(from, to, opts);
    }) as typeof fs.cpSync);
    await bootCompileModules();
    expect(lines()).toContain('[Shared] m 1.0.0 could not be compiled on this machine at this start (disk full); this machine does not load it, and compiles it again at the next start');
    expect(onModuleCode({ name: 'm', path: path.join(rig.state.dist, 'm'), version: '1.0.0' })).toBe('skip');
  });

  it('rm1 step throws: a judged module whose write throws is left out and its dist folder deleted', async () => {
    await rig.inPlace('m', M1);
    newBuild();
    rig.writeTree(path.join(rig.state.dist, 'm'), { 'index.js': 'exports.v = 1;\n', 'sub/a.js': '1;\n' });
    compiles(() => {
      breakRecord();
      return { success: true, duration: 0, diagnostics: [] };
    });
    await bootCompileModules();
    expect(lines().some(l => l.startsWith('[Error] m: finishing its start failed ('))).toBe(true);
    expect(rig.dist('m')).toBeNull();
    expect(onModuleCode({ name: 'm', path: path.join(rig.state.dist, 'm'), version: '1.0.0' })).toBe('skip');
  });

  it('rm1 step throws in development: the live folder, which is also the dist folder, is kept', async () => {
    const dir = rig.state.dist;
    _setModuleDirs({ source: dir, build: dir, dist: dir, backups: rig.state.backups, buildFile: path.join(rig.state.root, 'dist', '.build-complete') });
    fakeLoader.source = dir;
    await rig.inPlace('m', M1);
    newBuild();
    compiles(() => {
      breakRecord();
      return { success: true, duration: 0, diagnostics: [] };
    });
    await bootCompileModules();
    expect(lines().some(l => l.startsWith('[Error] m: finishing its start failed ('))).toBe(true);
    expect(rig.readTree(path.join(dir, 'm'))).toEqual(M1);
  });
});

describe('the modules this boot swapped', () => {
  it("rm1 other's errors swapped: a compile failing only in another module's files keeps the swap", async () => {
    const { u } = await bootUpdate();
    compiles(otherError);
    await bootCompileModules();
    expect(rig.entry('m')?.applying).toMatchObject({ to: u });
    expect(rig.entry('m')?.failedSha).toBeNull();
    expect(linesOf('m')).toEqual([]);
  });

  it("rm1 own errors swapped: a compile failing in the module's files marks the version failed, not retried", async () => {
    const { s, u } = await bootUpdate();
    compiles(() => ownError('m'));
    await bootCompileModules();
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u, retryAt: null, applying: null });
    expect(linesOf('m').some(l => l.includes(`failed to load on this machine (${OWN_M}); this machine keeps the previous version`))).toBe(true);
  });

  it('rm1 nothing kept: a first install that fails runs no second compile, and the others are judged by the first', async () => {
    const sN = await rig.inPlace('n', N1);
    newBuild();
    const u = await rig.publish('m', M1);
    await bootSwap('m', u);
    const calls = fakeLoader.compileCalls;
    compiles(() => ownError('m'), () => ownError('n'));
    await bootCompileModules();
    expect(fakeLoader.compileCalls).toBe(calls + 1);
    expect(rig.entry('n')).toMatchObject({ built: { sha: sN, buildId: 'image-2' } });
    expect(rig.entry('n')?.noCompile ?? null).toBeNull();
    expect(lines().filter(l => l.includes('does not compile'))).toEqual([]);
  });

  it('rm1 absent beside kept: a failed first install keeps no copy even when a second compile runs for another', async () => {
    await rig.inPlace('n', N1);
    const uN = await rig.publish('n', N2, '2.0.0');
    const uM = await rig.publish('m', M1);
    beginBootApplies();
    for (const [module, to] of [['m', uM], ['n', uN]] as const) {
      expect((await rig.apply(module, to)).outcome).toBe('loaded');
      expect(rig.entry(module)?.applying).toMatchObject({ to });
    }
    lines().length = 0;
    const calls = fakeLoader.compileCalls;
    compiles(() => ({ ...ownError('m'), diagnostics: [...ownError('m').diagnostics, ...ownError('n').diagnostics] }));
    await bootCompileModules();
    expect(fakeLoader.compileCalls).toBe(calls + 2);
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', built: null, failedSha: uM });
    expect(linesOf('m').some(l => l.includes('this machine keeps no copy of it'))).toBe(true);
    expect(linesOf('m').some(l => l.includes('the previous version'))).toBe(false);
  });
});

describe('the restored version after the second compile', () => {
  async function failedThen(second: () => CompileResult): Promise<{ s: string; u: string }> {
    const out = await bootUpdate();
    compiles(() => ownError('m'), second);
    await bootCompileModules();
    expect(rig.entry('m')).toMatchObject({ sha: out.s, failedSha: out.u, applying: null });
    return out;
  }

  const keptPrevious = () => linesOf('m').some(l => l.includes(`failed to load on this machine (${OWN_M}); this machine keeps the previous version`));
  const bothFailed = (second: string) => linesOf('m').some(l => l.includes(`failed to load on this machine (${OWN_M}), and the previous version did not load either (${second}); this machine runs without m until a version loads`));

  it("rm1 second compile fails elsewhere: the previous version is written built and kept", async () => {
    const { s } = await failedThen(otherError);
    expect(rig.entry('m')?.built).toMatchObject({ sha: s });
    expect(keptPrevious()).toBe(true);
    expect(linesOf('m').some(l => l.includes('did not load either'))).toBe(false);
  });

  it("rm1 second compile fails in its files: both versions failed, nothing written built", async () => {
    await failedThen(() => ownError('m'));
    expect(rig.entry('m')?.built).toBeNull();
    expect(bothFailed(OWN_M)).toBe(true);
    expect(keptPrevious()).toBe(false);
  });

  it('rm1 second compile names no file: both versions failed with its error', async () => {
    await failedThen(noFile);
    expect(rig.entry('m')?.built).toBeNull();
    expect(bothFailed('Command failed: tsc (killed)')).toBe(true);
    expect(keptPrevious()).toBe(false);
  });

  it('rm1 held back: a held previous version that does not compile is not written built', async () => {
    const { s } = await bootUpdate();
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    read.record.modules.m = { ...read.record.modules.m, heldSha: s };
    writeStoreRecord(read.record);
    compiles(() => ownError('m'), () => ownError('m'));
    await bootCompileModules();
    expect(rig.entry('m')).toMatchObject({ sha: s, heldSha: s, built: null });
    expect(linesOf('m').some(l => l.includes('It keeps the previous version on disk but does not load it'))).toBe(true);
  });

  it('rm1 restore step throws: a throw while the restored version is judged logs T33', async () => {
    await bootUpdate();
    compiles(() => ownError('m'), () => {
      breakRecord();
      return { success: true, duration: 0, diagnostics: [] };
    });
    await bootCompileModules();
    expect(lines().some(l => l.startsWith('[Error] m: finishing its start failed ('))).toBe(true);
  });
});

describe('the load check after the boot load', () => {
  it('rm1 nothing kept at load: a first install that failed to load runs no compile', async () => {
    const u = await rig.publish('m', M1);
    await bootSwap('m', u);
    await bootCompileModules();
    expect(rig.entry('m')?.applying).toMatchObject({ to: u });
    const calls = fakeLoader.compileCalls;
    await bootLoadCheck({} as Client, []);
    expect(fakeLoader.compileCalls).toBe(calls);
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', failedSha: u, applying: null });
    expect(linesOf('m').some(l => l.includes('(m recorded a load failure); this machine keeps no copy of it'))).toBe(true);
  });
});
