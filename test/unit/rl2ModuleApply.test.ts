import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ source: '', build: '', dist: '' }));

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    getModulesDir: () => paths.dist || real.getModulesDir(),
    getSourceModulesDir: () => paths.source || real.getSourceModulesDir(),
    getBuildModulesDir: () => paths.build || real.getBuildModulesDir(),
  };
});

import fs from 'fs';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';
import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { setView } from '../helpers/nb6Mirror';
import { readStoreRecord, writeStoreRecord, type ModuleEntry } from '../../src/bot/internalSetup/utils/sharedRecords';
import { withStoreLock } from '../../src/bot/internalSetup/utils/appStoreManager';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { MODULE_STATUS_SQL, _setModuleDirs } from '../../src/bot/internalSetup/utils/moduleApply';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const FAILING = { ...U_FILES, 'fail.txt': 'index.js threw: boom' };

beforeEach(() => rig.setup());
afterEach(async () => {
  paths.source = '';
  paths.build = '';
  paths.dist = '';
  await rig.teardown();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

type TxSpec = { check: unknown; statements: (arg: null) => Array<{ text: string; values: unknown[] }> };

/** The data pool's sharedTx with `before` run on each status upsert first; `before` may throw in its place. */
function onStatusTx(before: () => void): void {
  const backend = rig.state.pg.backend as unknown as { sharedTx: (spec: TxSpec) => Promise<unknown> };
  const real = backend.sharedTx.bind(backend);
  vi.spyOn(backend, 'sharedTx').mockImplementation(async (spec: TxSpec) => {
    if (spec.check === null && spec.statements(null)[0]?.text === MODULE_STATUS_SQL) before();
    return real(spec);
  });
}

describe('the default folders', () => {
  it('rl2 build id: an applied entry records the text of .build-complete two levels above the dist modules folder', async () => {
    paths.source = rig.state.source;
    paths.build = rig.state.build;
    paths.dist = rig.state.dist;
    _setModuleDirs(null);
    fs.writeFileSync(path.join(rig.state.root, 'dist', '.build-complete'), 'build-7');
    const s = await rig.inPlace('m', S_FILES);
    expect(rig.live('m')).toEqual(S_FILES);
    expect(rig.entry('m')?.built).toEqual({ sha: s, buildId: 'build-7' });
  });
});

describe('backup names', () => {
  it('rl2 free path: a removal whose backup name and its -1 are taken moves the folder to -2 and leaves both alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = Date.now();
    vi.setSystemTime(at);
    await rig.inPlace('m', S_FILES);
    rig.writeTree(path.join(rig.state.backups, `m-${at}`), { 'index.js': 'first' });
    rig.writeTree(path.join(rig.state.backups, `m-${at}-1`), { 'index.js': 'second' });
    const result = await rig.apply('m', 'absent');
    expect(result.outcome).toBe('applied');
    expect(rig.backupsOf('m')).toEqual([`m-${at}`, `m-${at}-1`, `m-${at}-2`]);
    expect(rig.readTree(path.join(rig.state.backups, `m-${at}`))).toEqual({ 'index.js': 'first' });
    expect(rig.readTree(path.join(rig.state.backups, `m-${at}-1`))).toEqual({ 'index.js': 'second' });
    expect(rig.readTree(path.join(rig.state.backups, `m-${at}-2`))).toEqual(S_FILES);
    expect(rig.live('m')).toBeNull();
  });
});

describe('development, one folder for source, build and dist', () => {
  it('rl2 dev mode: an install and a failed update keep the live folder, and the failed version goes to backups', async () => {
    const dir = rig.state.dist;
    _setModuleDirs({ source: dir, build: dir, dist: dir, backups: rig.state.backups, buildFile: path.join(rig.state.root, 'none') });
    fakeLoader.source = dir;
    const s = await rig.inPlace('m', S_FILES);
    expect(rig.dist('m')).toEqual(S_FILES);
    const u = await rig.publish('m', FAILING, '2.0.0');
    const result = await rig.apply('m', u);
    expect(result).toMatchObject({ outcome: 'failed', kept: 'previous' });
    expect(rig.dist('m')).toEqual(S_FILES);
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: u });
    const failed = rig.backupsOf('m').filter(n => n.endsWith('-failed'));
    expect(failed).toHaveLength(1);
    expect(rig.readTree(path.join(rig.state.backups, failed[0]))).toEqual(FAILING);
  });
});

describe('the entry an apply writes first', () => {
  it('rl2 empty entry: during a first install the stored entry holds sha absent and the apply', async () => {
    const s = await rig.publish('m', S_FILES);
    let seen: ModuleEntry | undefined;
    fakeLoader.duringLoad = () => { seen = rig.entry('m'); };
    const result = await rig.apply('m', s);
    expect(result.outcome).toBe('applied');
    expect(seen?.sha).toBe('absent');
    expect(seen?.applying).toMatchObject({ from: 'absent', to: s });
  });
});

describe('the status upsert', () => {
  it('rl2 status throw: an upsert whose transaction throws leaves the status in the entry and stores no row', async () => {
    const s = await rig.publish('m', S_FILES);
    onStatusTx(() => { throw new Error('connection reset'); });
    const result = await rig.apply('m', s);
    expect(result.outcome).toBe('applied');
    expect(rig.status('m')).toEqual([]);
    expect(rig.entry('m')?.status).toMatchObject({ state: 'applied', sha: s });
  });

  it('rl2 status seq: an answer does not clear a newer status written while the upsert ran', async () => {
    const s = await rig.publish('m', S_FILES);
    onStatusTx(() => {
      withStoreLock(() => {
        const read = readStoreRecord();
        if (!read.ok) throw new Error(read.reason);
        const entry = read.record.modules.m;
        if (!entry.status) throw new Error('no status to replace');
        read.record.modules.m = { ...entry, status: { ...entry.status, state: 'failed', error: 'newer', seq: entry.status.seq + 1 } };
        writeStoreRecord(read.record);
      });
    });
    const result = await rig.apply('m', s);
    expect(result.outcome).toBe('applied');
    expect(rig.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: s })]);
    expect(rig.entry('m')?.status).toMatchObject({ state: 'failed', error: 'newer' });
  });

  it('rl2 main moved: the main changing during the load sends no status and keeps it in the entry', async () => {
    const s = await rig.publish('m', S_FILES);
    fakeLoader.duringLoad = () => { setView(2, 'ALPHA'); };
    const result = await rig.apply('m', s);
    expect(result.outcome).toBe('applied');
    expect(rig.status('m')).toEqual([]);
    expect(rig.entry('m')).toMatchObject({ main: '1:ALPHA', status: expect.objectContaining({ state: 'applied', sha: s }) });
  });
});

describe('the load failure log', () => {
  it('rl2 T1 none: a first install that fails with no writer named logs an empty machine and no copy kept', async () => {
    const u = await rig.publish('m', FAILING, '2.0.0');
    const result = await rig.apply('m', u, { updatedBy: null });
    expect(result).toMatchObject({ outcome: 'failed', kept: 'none' });
    expect(shared()).toEqual([
      '[Shared] m 2.0.0 from  failed to load on this machine (index.js threw: boom); this machine keeps no copy of it and does not try 2.0.0 again until m is updated, or uninstalled and installed again',
    ]);
  });
});

describe("T11's head b", () => {
  it('rl2 T11 b: a superseded live folder of the entry version is logged with the machine and generation of the main', async () => {
    await rig.inPlace('m', S_FILES, '1.0.0');
    setView(3, 'CHARLIE');
    const u = await rig.publish('m', U_FILES, '2.0.0');
    rig.state.lines.length = 0;
    const result = await rig.apply('m', u, { displaced: 'superseded', tag: '3:CHARLIE' });
    expect(result.outcome).toBe('applied');
    const live = path.join(rig.state.source, 'm');
    const lines = shared();
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`[Shared] Moved ${live} to ${dataPath('_superseded')}`)).toBe(true);
    expect(lines[0].endsWith(": it held the version this machine took from the database before the switch to CHARLIE (generation 3); the database's version is back in its place")).toBe(true);
  });

  it('rl2 T11 b no view: with no main view at the log, the head names no machine and generation 0', async () => {
    await rig.inPlace('m', S_FILES, '1.0.0');
    const u = await rig.publish('m', U_FILES, '2.0.0');
    rig.state.lines.length = 0;
    fakeLoader.duringLoad = () => { setMainChooser(null); };
    const result = await rig.apply('m', u, { displaced: 'superseded' });
    expect(result.outcome).toBe('applied');
    const lines = shared();
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith(": it held the version this machine took from the database before the switch to  (generation 0); the database's version is back in its place")).toBe(true);
  });
});
