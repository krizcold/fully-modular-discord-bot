import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The load check of a boot apply (NB6 decision 45 (6) and its f): a module this boot swapped in fails when it is not
// registered or a load failure names it or a path under its dist folder; only then is it put back. Run through the
// boot steps of runBot over the rig of NB6 part 18, with the load check called directly so its answer can be read.

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
import { bootRig } from '../helpers/nb6BootRig';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { beginBootApplies, bootCompileModules, bootLoadCheck, recoverModuleApplies } from '../../src/bot/internalSetup/utils/moduleApply';
import { onModuleCode } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { recordLoadFailure } from '../../src/bot/internalSetup/utils/loadFailures';
import { bootShared } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';

const rig = bootRig();
const shared = () => rig.apply.state.lines.filter(l => l.startsWith('[Shared]'));
const underDist = (module: string) => path.join(rig.apply.state.dist, module, 'commands', 'broken.js');

beforeEach(async () => {
  await rig.setup();
  h.manifests = rig.manifests;
});
afterEach(async () => {
  await rig.teardown();
});

/** runBot's boot up to the load check, answering what the load check answers, as "<name>@<version>". */
async function bootAnswer(): Promise<string[]> {
  rig.newProcess();
  recoverModuleApplies();
  beginBootApplies();
  const answer = await bootShared();
  if (answer !== 'done') throw new Error(`bootShared answered ${answer}`);
  await bootCompileModules();
  const loaded = await new ModuleLoader(rig.client, { onModuleCode }).loadAllModules();
  const out = await bootLoadCheck(rig.client, loaded);
  return out.map(m => `${m.manifest.name}@${m.manifest.version}`);
}

/** The swapped-in version registers, and its load records a failure naming `what`. */
function registersWithFailure(module: string, version: string, what: () => string): void {
  rig.code.set(`${module}@${version}`, { onLoad: () => recordLoadFailure(what()) });
}

/** The live folder of the module changed outside the bot, so the next swap moves it aside and has no version to put back. */
function changeLiveFolder(module: string): void {
  fs.writeFileSync(path.join(rig.apply.state.source, module, 'index.js'), 'exports.v = "edited by hand";\n');
}

const T1 = (module: string, version: string, error: string) =>
  new RegExp(`^\\[Shared\\] ${module} ${version.replace(/\./g, '\\.')} from .+ failed to load on this machine \\(${error}\\); this machine keeps the previous version and does not try ${version.replace(/\./g, '\\.')} again until ${module} is updated, or uninstalled and installed again$`);

describe('which load failures fail a module the boot swapped in', () => {
  it('rm3 other module: a failure of a module the boot did not swap leaves the swapped one loaded and its apply open', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    await rig.inPlace('n', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.code.set('n@1.0.0', { loadThrows: new Error('n threw') });
    expect(await bootAnswer()).toEqual(['m@2.0.0']);
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    expect(rig.apply.entry('m')).toMatchObject({ failedSha: null, applying: { from: s, to: u } });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: s })]);
    expect(shared().filter(l => l.includes('failed to load on this machine'))).toEqual([]);
  });

  it('rm3 other path: a failure under another module\'s dist folder leaves the swapped one loaded', async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.inPlace('n', '1.0.0');
    await rig.publish('m', '2.0.0');
    rig.code.set('n@1.0.0', { onLoad: () => recordLoadFailure(underDist('n')) });
    expect(await bootAnswer()).toEqual(['m@2.0.0', 'n@1.0.0']);
    expect(rig.apply.entry('m')?.failedSha).toBeNull();
  });

  it('rm3 own path: registered, but a failure under its dist folder: put back, the previous version answered in its place, T1 with the recorded failure', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    registersWithFailure('m', '2.0.0', () => underDist('m'));
    expect(await bootAnswer()).toEqual(['m@1.0.0']);
    expect(rig.loaded()).toEqual(['m@1.0.0']);
    expect(rig.apply.state.lines).toContain('[ModuleRegistry] Unloading module: m');
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: u, applying: null });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: 'm recorded a load failure' })]);
    expect(shared().some(l => T1('m', '2.0.0', 'm recorded a load failure').test(l))).toBe(true);
  });

  it('rm3 own name: registered, but a failure naming the module: put back and the previous version loaded', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    registersWithFailure('m', '2.0.0', () => 'm');
    expect(await bootAnswer()).toEqual(['m@1.0.0']);
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: u, applying: null });
  });

  it('rm3 turn after a put-back: the start of the version put back does not finish the failed apply at its turn', async () => {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    registersWithFailure('m', '2.0.0', () => underDist('m'));
    await rig.boot();
    expect(rig.loaded()).toEqual(['m@1.0.0']);
    await rig.turns();
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: u, applying: null });
    expect(rig.apply.live('m')).toEqual({ 'module.json': expect.stringContaining('"1.0.0"'), 'index.js': "exports.v = '1.0.0';\n" });
  });
});

describe('the modules the load check answers', () => {
  it('rm3 replaced in place: the failed module after another is answered at its own place by the version put back', async () => {
    await rig.inPlace('a', '1.0.0');
    await rig.inPlace('m', '1.0.0');
    await rig.publish('m', '2.0.0');
    registersWithFailure('m', '2.0.0', () => underDist('m'));
    expect(await bootAnswer()).toEqual(['a@1.0.0', 'm@1.0.0']);
  });

  it('rm3 dropped first: a registered failed module with no version to put back is left out of the answer and the registry', async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.publish('m', '2.0.0');
    changeLiveFolder('m');
    registersWithFailure('m', '2.0.0', () => underDist('m'));
    expect(await bootAnswer()).toEqual([]);
    expect(rig.loaded()).toEqual([]);
    expect(shared().some(l => l.endsWith("the database's version failed to load on this machine (see the line above)"))).toBe(true);
  });

  it('rm3 not loaded, none put back: a failed module that never loaded leaves the other modules in the answer', async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.inPlace('n', '1.0.0');
    await rig.publish('m', '2.0.0');
    changeLiveFolder('m');
    rig.code.set('m@2.0.0', { loadThrows: new Error('index.js threw: boom') });
    expect(await bootAnswer()).toEqual(['n@1.0.0']);
    expect(rig.loaded()).toEqual(['n@1.0.0']);
  });
});

describe('the status rows the load check sends', () => {
  it('rm3 two failed: each module put back has its failed status sent at the boot', async () => {
    await rig.inPlace('m', '1.0.0');
    await rig.inPlace('n', '1.0.0');
    const mu = await rig.publish('m', '2.0.0');
    const nu = await rig.publish('n', '2.0.0');
    rig.code.set('m@2.0.0', { loadThrows: new Error('m threw') });
    rig.code.set('n@2.0.0', { loadThrows: new Error('n threw') });
    await rig.boot();
    expect(rig.loaded()).toEqual(['m@1.0.0', 'n@1.0.0']);
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: mu, error: 'm threw' })]);
    expect(rig.apply.status('n')).toEqual([expect.objectContaining({ state: 'failed', sha: nu, error: 'n threw' })]);
  });

  it('rm3 put-back threw: a module whose put-back threw writes nothing more, its pending status is not sent', async () => {
    const ms = await rig.inPlace('m', '1.0.0');
    await rig.inPlace('n', '1.0.0');
    const mu = await rig.publish('m', '2.0.0');
    await rig.publish('n', '2.0.0');
    rig.code.set('n@2.0.0', { loadThrows: new Error('n threw') });
    let pendingSeq = 0;
    const loadModule = vi.mocked(ModuleLoader.prototype.loadModule);
    const inner = loadModule.getMockImplementation()!;
    loadModule.mockImplementation(async function (this: ModuleLoader, manifest: any, dir: string) {
      if (manifest.name === 'm' && manifest.version === '2.0.0') {
        const read = readStoreRecord();
        if (!read.ok) throw new Error(read.reason);
        pendingSeq = (read.record.statusSeq ?? 0) + 1;
        read.record.statusSeq = pendingSeq;
        read.record.modules.m = { ...read.record.modules.m, status: { state: 'applied', sha: ms, error: null, at: new Date().toISOString(), seq: pendingSeq } };
        writeStoreRecord(read.record);
        throw new Error('m threw');
      }
      return inner.call(this, manifest, dir);
    });
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      const name = path.basename(String(to));
      if (name.startsWith('m-') && name.includes('-failed')) throw Object.assign(new Error('EPERM: injected, rename'), { code: 'EPERM' });
      return real(from, to);
    });
    await expect(rig.boot()).resolves.toBeUndefined();
    expect(rig.apply.state.lines).toContain('[Error] m: finishing its start failed (EPERM: injected, rename); the bot finishes it at its next start, and until then this machine applies no change of m');
    expect(rig.loaded()).toEqual(['n@1.0.0']);
    expect(pendingSeq).toBeGreaterThan(0);
    expect(rig.apply.entry('m')).toMatchObject({ applying: { from: ms, to: mu }, status: { seq: pendingSeq } });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: ms })]);
    expect(rig.apply.status('m').some(row => (row as { seq?: number }).seq === pendingSeq)).toBe(false);
  });
});
