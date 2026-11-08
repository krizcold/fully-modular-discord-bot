import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 10 (wip-redesign/sheets/NB6.md decisions 43, 49, 58, 70, 80, 83 and 92): `applyModuleChange` and the pass's
// module step with a fake loader and a scripted compile, over the rows the real publish writes. Rows 61, 63, 65, 105,
// 106, 116, 150 to 153, 213, 214, 267, 305, 306, 311, 339 and 356. Row 340 (45 (6)'s f at boot) is part 18's.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';
import { applyRig, fakeLoader, moduleShaOfFiles, reloaderFakes } from '../helpers/nb6ApplyRig';
import { moduleShaOf, readModuleFolder } from '../../src/bot/internalSetup/utils/sharedModules';
import { shaOf } from '../../src/bot/internalSetup/utils/sharedStore';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { recoverModuleApplies } from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetModuleCrashes, closeWindow, countCrash, openWindow, startModule } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { pgError } from '../helpers/sharedRows';
import { clearLoadFailures, getHeldBack } from '../../src/bot/internalSetup/utils/loadFailures';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n', 'old-only.js': '1' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const FAILING = { ...U_FILES, 'fail.txt': 'index.js threw: boom' };

beforeEach(() => rig.setup());
afterEach(async () => {
  setStoppedServingHook(null);
  await rig.teardown();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

/** Two crashes of the version in place while it started, as `guardUncaught` counts them across two processes. */
function crashTwice(module: string, sha: string, version: string): void {
  for (let i = 0; i < 2; i += 1) {
    _resetModuleCrashes();
    const start = startModule(module, sha, version, path.join(rig.state.source, module), { boot: true });
    if (typeof start === 'string') throw new Error(start);
    openWindow(start);
    countCrash(new Error(`crash ${i + 1}`));
    closeWindow(start);
  }
  _resetModuleCrashes();
}

describe('the apply', () => {
  it('row 61: an apply swaps the folders, loads the new version and writes the entry and the status last', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.loads = [];
    const result = await rig.apply('m', u);
    expect(result).toEqual({ outcome: 'applied', reason: null, error: null, loaded: true });
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.built('m')).toEqual(U_FILES);
    expect(rig.dist('m')).toBeNull();
    expect(fakeLoader.loads).toEqual([{ module: 'm', sha: u }]);
    expect(rig.entry('m')).toMatchObject({ sha: u, built: { sha: u, buildId: null }, failedSha: null, retryAt: null, heldSha: null, status: null, main: '1:ALPHA' });
    expect(rig.entry('m')?.applying ?? null).toBeNull();
    expect(rig.status('m')).toEqual([expect.objectContaining({ sha: u, state: 'applied', error: null })]);
    expect(rig.backupsOf('m')).toEqual([]);
    expect(s).not.toBe(u);
    expect(shared()).toEqual([]);
  });

  it('row 63: a load failure puts the previous folder back, loads it, and writes failedSha with a failed status and T1', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    fakeLoader.loads = [];
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', error: 'index.js threw: boom', kept: 'previous' });
    expect(rig.live('m')).toEqual(S_FILES);
    expect(rig.built('m')).toEqual(S_FILES);
    expect(fakeLoader.loads).toEqual([{ module: 'm', sha: u }, { module: 'm', sha: s }]);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u, built: { sha: s, buildId: null } });
    expect(rig.status('m')).toEqual([expect.objectContaining({ sha: u, state: 'failed', error: 'index.js threw: boom' })]);
    expect(rig.backupsOf('m')).toEqual([expect.stringMatching(/^m-\d+-failed$/)]);
    expect(shared()).toEqual([
      '[Shared] m 2.0.0 from BRAVO failed to load on this machine (index.js threw: boom); this machine keeps the previous version and does not try 2.0.0 again until m is updated, or uninstalled and installed again',
    ]);
  });

  it('row 65: a removal unloads the module, moves its source to backups, deletes build and dist and drops the entry last', async () => {
    await rig.inPlace('m', S_FILES);
    fs.mkdirSync(path.join(rig.state.dist, 'm'), { recursive: true });
    fs.writeFileSync(path.join(rig.state.dist, 'm', 'index.js'), 'compiled');
    await rig.unpublish('m');
    await rig.pass();
    expect(fakeLoader.unloads).toEqual(['m']);
    expect(rig.live('m')).toBeNull();
    expect(rig.built('m')).toBeNull();
    expect(rig.dist('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
    expect(rig.backupsOf('m')).toEqual([expect.stringMatching(/^m-\d+$/)]);
  });

  it('row 116: the pass skips a row whose sha is the entry failedSha, and one whose retryAt is in the future', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    await rig.apply('m', u);
    fakeLoader.loads = [];
    const compiles = fakeLoader.compileCalls;
    await rig.pass();
    expect(fakeLoader.loads).toEqual([]);
    expect(fakeLoader.compileCalls).toBe(compiles);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u });

    const v = await rig.publish('m', { ...U_FILES, 'v3.js': '3' }, '3.0.0');
    const record = readStoreRecord();
    if (!record.ok) throw new Error(record.reason);
    record.record.modules.m = { ...record.record.modules.m, retryAt: Date.now() + 60_000 };
    writeStoreRecord(record.record);
    await rig.pass();
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.entry('m')?.sha).toBe(s);
    expect(v).not.toBe(s);
  });
});

describe('the pass', () => {
  it('row 105: a folder with no row and no entry goes to backups as -orphan, its build and dist deleted, with 33\'s line', async () => {
    rig.writeTree(path.join(rig.state.source, 'stray'), { 'index.js': 'stray' });
    rig.writeTree(path.join(rig.state.build, 'stray'), { 'index.js': 'stray' });
    rig.writeTree(path.join(rig.state.dist, 'stray'), { 'index.js': 'compiled' });
    await rig.pass();
    expect(rig.live('stray')).toBeNull();
    expect(rig.built('stray')).toBeNull();
    expect(rig.dist('stray')).toBeNull();
    const [name] = rig.backupsOf('stray');
    expect(name).toMatch(/^stray-\d+-orphan$/);
    expect(rig.state.lines).toContain(`[Shared] Moved the module folder stray to ${path.join(rig.state.backups, name)}: the database does not list it as installed`);
  });

  it('row 106: installed.json lists a module the database holds no files of: the entry stays, T13 once', async () => {
    const s = await rig.inPlace('m', S_FILES);
    fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
    fs.writeFileSync(dataPath('global', 'appstore', 'installed.json'), JSON.stringify({ modules: { m: { version: '1.0.0' } } }));
    rig.state.rows.modules.delete('m');
    rig.state.rows.moduleFiles.delete('m');
    await rig.pass();
    await rig.pass();
    expect(rig.entry('m')?.sha).toBe(s);
    expect(rig.live('m')).toEqual(S_FILES);
    expect(shared()).toEqual(['[Shared] m is listed as installed, but the database holds none of its files; uninstall it from the App Store tab, then install it again']);
  });

  it('row 150: a folder changed outside the bot with no row goes to _superseded, with T11\'s no-row tail', async () => {
    await rig.inPlace('m', S_FILES);
    fs.writeFileSync(path.join(rig.state.source, 'm', 'index.js'), 'edited by hand');
    await rig.unpublish('m');
    await rig.pass();
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
    const line = shared().find(l => l.startsWith('[Shared] Moved'));
    expect(line).toMatch(/: it differed from the version this machine last took from the database \(changed outside the bot, or left by a crash\); the database holds no such file, so nothing was put back$/);
    expect(line).toContain(path.join('_superseded'));
  });

  it('row 151: a folder changed outside the bot with a row: the row is applied from absent, T11 with the written tail', async () => {
    await rig.inPlace('m', S_FILES);
    fs.writeFileSync(path.join(rig.state.source, 'm', 'index.js'), 'edited by hand');
    const u = await rig.publish('m', U_FILES, '2.0.0');
    await rig.pass();
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.entry('m')).toMatchObject({ sha: u });
    expect(rig.backupsOf('m')).toEqual([]);
    const superseded = fs.readdirSync(dataPath('_superseded'));
    expect(superseded).toHaveLength(1);
    expect(rig.readTree(path.join(dataPath('_superseded'), superseded[0], 'appstore-modules', 'm'))).toMatchObject({ 'index.js': 'edited by hand' });
    expect(shared().find(l => l.startsWith('[Shared] Moved'))).toMatch(/; the database's version is back in its place$/);
  });

  it('row 152: a folder moved aside whose row is the failed version stays absent, with T11\'s failed-sha tail', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    await rig.apply('m', u);
    rig.state.lines.length = 0;
    fs.writeFileSync(path.join(rig.state.source, 'm', 'index.js'), 'edited by hand');
    fakeLoader.loads = [];
    await rig.pass();
    expect(rig.live('m')).toBeNull();
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.entry('m')).toMatchObject({ sha: 'absent', failedSha: u });
    expect(shared()).toEqual([expect.stringMatching(/; the database's version 2\.0\.0 failed to load on this machine before, so this machine has no copy of m until it is updated, or uninstalled and installed again$/)]);
    await rig.pass();
    expect(rig.live('m')).toBeNull();
    expect(fakeLoader.loads).toEqual([]);
    expect(s).not.toBe(u);
  });

  it('row 153: in development a folder under the runtime modules dir with no row and no entry is left alone', async () => {
    const { _setModuleDirs } = await import('../../src/bot/internalSetup/utils/moduleApply');
    _setModuleDirs({ source: rig.state.dist, build: rig.state.dist, dist: rig.state.dist, backups: rig.state.backups, buildFile: path.join(rig.state.root, 'none') });
    rig.writeTree(path.join(rig.state.dist, 'repoModule'), { 'index.js': 'the repo own module' });
    await rig.pass();
    expect(rig.dist('repoModule')).toEqual({ 'index.js': 'the repo own module' });
    expect(rig.backupsOf('repoModule')).toEqual([]);
  });
});

describe('the status rows', () => {
  it('row 213: an upsert that fails after the entry write leaves the status in the entry; the next pass sends it and clears it', async () => {
    const s = await rig.publish('m', S_FILES);
    rig.state.rows.fault = sql => (sql.startsWith('INSERT INTO smdb_data.shared_module_status') ? pgError('40P01', 'deadlock detected') : undefined);
    await rig.apply('m', s);
    expect(rig.status('m')).toEqual([]);
    expect(rig.entry('m')?.status).toMatchObject({ state: 'applied', sha: s });
    rig.state.rows.fault = undefined;
    await rig.pass();
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: s })]);
    expect(rig.entry('m')?.status).toBeNull();
  });

  it('row 214: an applied status replaces an older failed row of this machine', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    await rig.apply('m', u);
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u })]);
    const v = await rig.publish('m', { ...U_FILES, 'fixed.js': 'fixed' }, '2.0.1');
    await rig.pass();
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: v, error: null })]);
  });

  it('row 267: step 0 drops a status whose entry main is not tag0 and sends nothing', async () => {
    const s = await rig.publish('m', S_FILES);
    rig.state.rows.fault = sql => (sql.startsWith('INSERT INTO smdb_data.shared_module_status') ? pgError('40P01', 'deadlock detected') : undefined);
    await rig.apply('m', s);
    rig.state.rows.fault = undefined;
    const record = readStoreRecord();
    if (!record.ok) throw new Error(record.reason);
    record.record.modules.m = { ...record.record.modules.m, main: '0' };
    writeStoreRecord(record.record);
    const sent = () => rig.state.pg.sent.filter(q => q.sql.startsWith('INSERT INTO smdb_data.shared_module_status')).length;
    const before = sent();
    await rig.pass();
    expect(sent()).toBe(before);
    expect(rig.status('m')).toEqual([]);
    expect(rig.entry('m')?.status).toBeNull();
  });

  it('row 311: a clock stepped back between two status writes of one process: the later status carries the higher seq and wins', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T12:00:00.000Z'));
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    await rig.apply('m', u);
    const first = rig.status('m')[0];
    vi.setSystemTime(new Date('2026-11-07T11:00:00.000Z'));
    const v = await rig.publish('m', { ...U_FILES, 'fixed.js': 'fixed' }, '2.0.1');
    await rig.apply('m', v);
    const second = rig.status('m')[0];
    expect(second).toMatchObject({ state: 'applied', sha: v });
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.at < first.at).toBe(true);
  });
});

describe('a held version', () => {
  async function heldS(): Promise<string> {
    const s = await rig.inPlace('m', S_FILES);
    crashTwice('m', s, '1.0.0');
    recoverModuleApplies();
    expect(rig.entry('m')).toMatchObject({ sha: s, heldSha: s });
    rig.state.lines.length = 0;
    fakeLoader.loads = [];
    return s;
  }

  it('row 305: a held module whose row names a new version that loads: the entry takes it and the hold ends', async () => {
    await heldS();
    const u = await rig.publish('m', U_FILES, '2.0.0');
    const result = await rig.apply('m', u);
    expect(result.outcome).toBe('applied');
    expect(rig.entry('m')).toMatchObject({ sha: u, heldSha: null });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: u })]);
  });

  it('rows 306 and 339: the new version fails to load: S is put back and stays held, compiled but not loaded, T1 held form and T24', async () => {
    const s = await heldS();
    const u = await rig.publish('m', FAILING, '2.0.0');
    const compiles = fakeLoader.compileCalls;
    clearLoadFailures();
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous' });
    expect(getHeldBack()).toEqual(['m']);
    expect(rig.live('m')).toEqual(S_FILES);
    expect(fakeLoader.loads).toEqual([{ module: 'm', sha: u }]);
    expect(fakeLoader.compileCalls).toBe(compiles + 2);
    expect(rig.entry('m')).toMatchObject({ sha: s, heldSha: s, failedSha: u, built: { sha: s, buildId: null } });
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: 'index.js threw: boom' })]);
    expect(rig.state.lines).toContain('[Reloader] m 1.0.0 was not loaded: this machine holds it back after the bot stopped twice while it was starting it (see the App Store tab)');
    expect(shared()).toEqual([
      '[Shared] m 2.0.0 from BRAVO failed to load on this machine (index.js threw: boom); this machine does not try 2.0.0 again until m is updated, or uninstalled and installed again. It keeps the previous version on disk but does not load it: that version is held back after the bot stopped twice while it was starting it',
    ]);
  });
});

describe('row 356: an entry left with applying, then the boot recovery', () => {
  it('puts the previous version back with T4, and the next pass applies the row again', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    fakeLoader.duringLoad = () => { setStoppedServingHook(() => true); };
    fakeLoader.compiles = [];
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'deferred', reason: 'stopped-serving' });
    setStoppedServingHook(null);
    fakeLoader.duringLoad = null;
    rig.state.lines.length = 0;
    // A throw of the start's end left the entry as an apply's run had it (decision 101); here a crash in the load left it.
    const record = readStoreRecord();
    if (!record.ok) throw new Error(record.reason);
    expect(record.record.modules.m.applying).toBeTruthy();
    recoverModuleApplies();
    expect(rig.entry('m')).toMatchObject({ sha: s });
    expect(rig.entry('m')?.applying ?? null).toBeNull();
    expect(rig.live('m')).toEqual(S_FILES);
    expect(shared()[0]).toMatch(/^\[Shared\] m: applying 2\.0\.0 was cut off when the bot process ended; put back the previous version from .+\. This machine applies the database's current version of m again at this start\.$/);
    await rig.pass();
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.entry('m')).toMatchObject({ sha: u });
    expect(moduleShaOfFiles(U_FILES)).toBe(u);
  });
});

describe('the fake loader', () => {
  it('records the module sha of the bytes on disk when a file is not UTF-8 text (row 57 [pg] read it as text)', async () => {
    const dir = path.join(rig.state.source, 'bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.v = 1;\n');
    fs.writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([0x00, 0x80, 0xff, 0xc3, 0x28]));
    await reloaderFakes.loadModuleUnmarked({}, 'bin');
    const real = moduleShaOf(readModuleFolder(dir).map(file => ({ rel: file.rel, sha: shaOf(file.bytes) })));
    expect(fakeLoader.loads).toEqual([{ module: 'bin', sha: real }]);
  });
});
