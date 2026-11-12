import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The App Store's install and uninstall on a Postgres bot (NB6 decision 35 with its checks): the refusals and their
// texts, the staged folder deleted on every failure, the credentials kept by an update, the store listing's flags after
// the landing, and the snapshot taken before each change. Same rig as nb6Publish.test.ts.

const h = vi.hoisted(() => ({ dirs: { source: '', build: '', dist: '', dev: '' }, snaps: [] as string[] }));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const execSync = (cmd: string) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: (operation: string) => { h.snaps.push(operation); } }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    getSourceModulesDir: () => h.dirs.source,
    getBuildModulesDir: () => h.dirs.build,
    getModulesDir: () => h.dirs.dist,
    getModulesDevDir: () => h.dirs.dev,
  };
});

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { applyRig, moduleShaOfFiles } from '../helpers/nb6ApplyRig';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const INSTALLED_FILE = path.join(STORE, 'installed.json');
const CREDS = 'global/appstore/credentials/m.json';
const CREDS_FILE = path.join(STORE, 'credentials', 'm.json');
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const V2 = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const N1 = { 'module.json': '{"name":"n","version":"3.0.0"}', 'index.js': 'exports.n = 1;\n' };

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  h.snaps = [];
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, 'repos.json'), JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
});

afterEach(async () => {
  setStoppedServingHook(null);
  useWebuiSessions(null);
  await rig.teardown();
});

/** The repository clone in the store's cache holds these modules, by folder. */
function clone(modules: Record<string, Record<string, string>>): void {
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [folder, files] of Object.entries(modules)) rig.writeTree(path.join(dir, 'Modules', folder), files);
}

const staged = () => (fs.existsSync(rig.state.source) ? fs.readdirSync(rig.state.source).filter(n => n.startsWith('.incoming-')) : []);
const moduleSql = () => rig.state.pg.sent.map(s => s.sql).filter(q => q.includes('shared_module'));
const storeDoc = (key: string) => {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  return read.record.docs[key];
};

async function installed(): Promise<AppStoreManager> {
  clone({ m: V1 });
  const m = new AppStoreManager();
  await m.installModule('m', REPO);
  expect(rig.live('m')).toEqual(V1);
  return m;
}

describe("the install's refusals", () => {
  it('a folder of m left in the source tree with no record: already installed, the folder untouched, nothing published', async () => {
    clone({ m: V1 });
    rig.writeTree(path.join(rig.state.source, 'm'), { 'mine.txt': 'kept' });
    const m = new AppStoreManager();
    const error = await m.installModule('m', REPO).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Module m is already installed');
    expect(rig.live('m')).toEqual({ 'mine.txt': 'kept' });
    expect(moduleSql()).toEqual([]);
    expect(rig.state.rows.modules.has('m')).toBe(false);
    expect(staged()).toEqual([]);
    expect(h.snaps).toEqual([]);
  });

  it('a Dev module named m: the conflict text, nothing published', async () => {
    clone({ m: V1 });
    rig.writeTree(path.join(h.dirs.dev, 'devrepo', 'Modules', 'mine'), { 'module.json': '{"name":"m","version":"9.0.0"}' });
    const m = new AppStoreManager();
    const error = await m.installModule('m', REPO).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Module m conflicts with a Dev module of the same name. Remove or rename the Dev module first.');
    expect(moduleSql()).toEqual([]);
    expect(rig.state.rows.modules.has('m')).toBe(false);
    expect(rig.live('m')).toBeNull();
    expect(staged()).toEqual([]);
  });
});

describe('the staged folder on a failure', () => {
  it('a module.json with no version: not installed, the staged copy deleted', async () => {
    clone({ m: { 'module.json': '{"name":"m"}', 'index.js': 'exports.v = 1;\n' } });
    const m = new AppStoreManager();
    const error = await m.installModule('m', REPO).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^module\.json in \.incoming-m-\d+ has no version$/);
    expect(staged()).toEqual([]);
    expect(moduleSql()).toEqual([]);
    expect(rig.live('m')).toBeNull();
  });

  it('a staged file that cannot be synced to disk: not installed, nothing published, the staged copy deleted', async () => {
    clone({ m: V1 });
    const m = new AppStoreManager();
    const stagedFds = new Set<number>();
    const realOpen = fs.openSync.bind(fs);
    const realFsync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode | null) => {
      const fd = realOpen(file, flags, mode);
      if (flags === 'r+' && String(file).includes('.incoming-m-')) stagedFds.add(fd);
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      if (stagedFds.has(fd)) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
      realFsync(fd);
    });
    const error = await m.installModule('m', REPO).catch(e => e);
    expect(stagedFds.size).toBeGreaterThan(0);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('EIO: i/o error, fsync');
    expect(rig.state.rows.modules.has('m')).toBe(false);
    expect(staged()).toEqual([]);
    expect(rig.live('m')).toBeNull();
    expect(fs.existsSync(INSTALLED_FILE)).toBe(false);
  });
});

describe('the landing', () => {
  it("an update keeps the module's credentials: the mirror file and its store entry stay", async () => {
    const m = await installed();
    await m.saveCredentialsAwaited('m', { KEY: 'v' });
    const before = fs.readFileSync(CREDS_FILE);
    const entry = storeDoc(CREDS);
    expect(entry).toBeDefined();
    clone({ m: V2 });
    const result = await m.updateModule('m');
    expect(result).toMatchObject({ success: true, newVersion: '2.0.0' });
    expect(fs.readFileSync(CREDS_FILE).equals(before)).toBe(true);
    expect(storeDoc(CREDS)).toEqual(entry);
    expect(rig.state.rows.docs.has(CREDS)).toBe(true);
  });

  it("the store listing shows m installed at its version after the install, and n, from the same clone, still not installed", async () => {
    clone({ m: V1, n: N1 });
    const m = new AppStoreManager();
    const answer = await m.installModule('m', REPO);
    expect(answer).toMatchObject({ module: 'm', to: moduleShaOfFiles(V1) });
    expect(m.getModuleInfo('m')).toMatchObject({ installed: true, installedVersion: '1.0.0' });
    expect(m.getModuleInfo('n')!.installed).toBe(false);
    expect(m.getModuleInfo('n')!.installedVersion).toBeUndefined();
  });

  it('the store listing shows m not installed, with no version, after the uninstall', async () => {
    const m = await installed();
    expect(m.getModuleInfo('m')).toMatchObject({ installed: true, installedVersion: '1.0.0' });
    await m.uninstallModule('m');
    expect(rig.state.rows.modules.has('m')).toBe(false);
    expect(m.getModuleInfo('m')!.installed).toBe(false);
    expect(m.getModuleInfo('m')!.installedVersion).toBeUndefined();
  });
});

describe("the uninstall's checks", () => {
  it('a module that is not installed: the refusal text, nothing unpublished', async () => {
    const m = new AppStoreManager();
    const error = await m.uninstallModule('m').catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Module m is not installed');
    expect(moduleSql()).toEqual([]);
    expect(rig.state.pg.sent.map(s => s.sql)).not.toContain('COMMIT');
    expect(h.snaps).toEqual([]);
  });

  it('another manager uninstalled m since this one installed it: this one reads the list again and answers not installed', async () => {
    const m = await installed();
    const other = new AppStoreManager();
    await other.uninstallModule('m');
    const sent = rig.state.pg.sent.length;
    const error = await m.uninstallModule('m').catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Module m is not installed');
    expect(rig.state.pg.sent.slice(sent).map(s => s.sql).filter(q => q.includes('shared_module'))).toEqual([]);
  });

  it('an unreadable installed.json: nothing changed, the module in place', async () => {
    const m = await installed();
    const sha = rig.state.rows.modules.get('m')?.sha;
    fs.writeFileSync(INSTALLED_FILE, '{ not json');
    const error = await m.uninstallModule('m').catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('The installed modules list (installed.json) could not be read, so nothing was changed.');
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
    expect(rig.live('m')).toEqual(V1);
  });
});

describe('the snapshot before a change', () => {
  it("the install takes the snapshot named 'install m'", async () => {
    await installed();
    expect(h.snaps).toEqual(['install m']);
  });

  it("the uninstall of a module whose folders are in place takes 'uninstall m'", async () => {
    const m = await installed();
    h.snaps = [];
    await m.uninstallModule('m');
    expect(h.snaps).toEqual(['uninstall m']);
  });

  it('the uninstall of a module with only its build folder left takes it too', async () => {
    const m = await installed();
    fs.rmSync(path.join(h.dirs.source, 'm'), { recursive: true, force: true });
    fs.rmSync(path.join(h.dirs.dist, 'm'), { recursive: true, force: true });
    rig.writeTree(path.join(h.dirs.build, 'm'), V1);
    h.snaps = [];
    await m.uninstallModule('m');
    expect(h.snaps).toEqual(['uninstall m']);
  });

  it('the uninstall of a module with no folder left takes none', async () => {
    const m = await installed();
    for (const dir of [h.dirs.source, h.dirs.build, h.dirs.dist]) fs.rmSync(path.join(dir, 'm'), { recursive: true, force: true });
    h.snaps = [];
    await m.uninstallModule('m');
    expect(rig.state.rows.modules.has('m')).toBe(false);
    expect(h.snaps).toEqual([]);
  });
});
