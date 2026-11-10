import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 decisions 4 and 5: the synchronous whole-file helpers run the folder chain after the rename and throw
// FolderSyncError when it fails, and every caller keeps the work that is in place and says it can't be confirmed.
// The chain itself is folderChain's (nb19FolderChain.test.ts); here its answer is set per folder, so these rows run on
// every platform.

const h = vi.hoisted(() => ({
  fail: new Map<string, { kind: 'sync' | 'open' | 'earlier'; errno: string }>(),
  chains: [] as string[],
  failRenameTo: new Set<string>(),
  script: new Map<string, Array<'ok' | { kind: 'sync' | 'open' | 'earlier'; errno: string }>>(),
  renameLandsThenFails: new Set<string>(),
  cloneFrom: null as string | null,
  first: null as null | { dir: string; errno: string },
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChainSync: (dir: string) => {
      const at = path.resolve(dir);
      h.chains.push(at);
      if (h.first && real.folderSyncFailed()) return { failed: true, kind: 'earlier', dir: h.first.dir, errno: h.first.errno, error: null };
      const next = h.script.get(at)?.shift();
      if (next === 'ok') return { failed: false };
      const f = next ?? h.fail.get(at);
      if (!f) return { failed: false };
      if (f.kind === 'sync') {
        real.noteFolderSyncFailure(at, f.errno);
        h.first ??= { dir: at, errno: f.errno };
      }
      return { failed: true, kind: f.kind, dir: at, errno: f.errno, error: null };
    },
  };
});

vi.mock('fs', async orig => {
  const real = await orig<any>();
  const wrapped = {
    ...real,
    renameSync: (from: any, to: any) => {
      if (h.failRenameTo.has(path.basename(String(to)))) throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
      if (h.renameLandsThenFails.delete(path.basename(String(to)))) {
        real.renameSync(from, to);
        throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
      }
      return real.renameSync(from, to);
    },
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const fsReal = await vi.importActual<any>('fs');
  const execSync = (cmd: string, opts: any = {}) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from(fsReal.readFileSync(path.join(opts.cwd, '.git', 'HEAD_HASH'), 'utf-8'));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    if (cmd.startsWith('git clone')) {
      const target = cmd.match(/"([^"]+)"$/)![1];
      if (h.cloneFrom) fsReal.cpSync(h.cloneFrom, target, { recursive: true });
      fsReal.mkdirSync(path.join(target, '.git'), { recursive: true });
      fsReal.writeFileSync(path.join(target, '.git', 'HEAD_HASH'), 'e'.repeat(40));
      return Buffer.from('');
    }
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  const root = process.env.DATA_DIR as string;
  return {
    ...real,
    getModulesDir: () => path.join(root, 'runtime-modules'),
    getSourceModulesDir: () => path.join(root, 'appstore-modules'),
    getBuildModulesDir: () => path.join(root, 'build-modules'),
    getModulesDevDir: () => path.join(root, 'modulesDev'),
  };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { atomicWriteFileSync } from '../../src/bot/internalSetup/utils/atomicWrite';
import { FolderSyncError, syncWords, writeErrorText } from '../../src/bot/internalSetup/utils/folderChain';
import { writeBackup } from '../../src/webui/utils/configBackups';
import { getNodeId } from '../../src/bot/internalSetup/fleet/nodeIdentity';
import { shardRecordPath, writeShardRecord } from '../../src/bot/internalSetup/fleet/shardRecord';
import { writeFileMarker } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { AppStoreManager, getAppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { InstallQueue } from '../../src/webui/utils/installQueue';
import { componentConfigPath } from '../../src/bot/internalSetup/utils/appStoreConfigFile';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { describeBulkModuleUpdate, triggerAllModuleUpdates, type BulkModuleUpdateResult } from '../../src/updater';

const STORE = dataPath('global', 'appstore');
const INSTALLED = path.join(STORE, 'installed.json');
const REPOS = path.join(STORE, 'repos.json');
const CLONE = path.join(STORE, 'cache', 'official-modules');
const SOURCE = dataPath('appstore-modules');
const BUILD = dataPath('build-modules');

const T1 = (file: string, kind: 'sync' | 'open' | 'earlier', dir: string, errno: string) => {
  const { why, next } = syncWords(kind, dir, errno);
  return `${file} is written, but ${why}, so can't confirm it is stored. ${next}`;
};
const failAt = (dir: string, errno = 'EIO', kind: 'sync' | 'open' | 'earlier' = 'sync') => h.fail.set(path.resolve(dir), { kind, errno });
function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  return undefined;
}
async function rejected(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  return undefined;
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function publish(name: string, version: string): void {
  write(path.join(CLONE, 'Modules', name, 'module.json'), JSON.stringify({ name, version }));
  write(path.join(CLONE, 'Modules', name, 'index.ts'), 'export {};');
  write(path.join(CLONE, '.git', 'HEAD_HASH'), 'a'.repeat(40));
}
const installed = (): Record<string, any> => JSON.parse(fs.readFileSync(INSTALLED, 'utf-8')).modules;

let errors: string[];
beforeEach(() => {
  h.fail.clear();
  h.chains.length = 0;
  h.failRenameTo.clear();
  h.script.clear();
  h.renameLandsThenFails.clear();
  h.cloneFrom = null;
  h.first = null;
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  for (const dir of [STORE, SOURCE, BUILD, dataPath('runtime-modules')]) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

describe('rows 15 to 18, 23 and 43: the helpers', () => {
  it('15: atomicWriteFileSync runs the chain from the file\'s folder; with chain false it does not', () => {
    const file = dataPath('nb19', 'new', 'a.json');
    atomicWriteFileSync(file, '{}');
    expect(h.chains).toEqual([path.resolve(path.dirname(file))]);
    h.chains.length = 0;
    atomicWriteFileSync(dataPath('nb19', 'new', 'b.json'), '{}', undefined, { chain: false });
    expect(h.chains).toEqual([]);
  });

  it('16: a failed chain throws FolderSyncError (EIO, written, T1) and the file holds the new bytes', () => {
    const file = dataPath('nb19', 'eio', 'a.json');
    failAt(path.dirname(file));
    const error = thrown(() => atomicWriteFileSync(file, '{"new":1}')) as FolderSyncError;
    expect(error).toBeInstanceOf(FolderSyncError);
    expect(error).toMatchObject({ name: 'FolderSyncError', code: 'EIO', kind: 'sync', written: true, file, dir: path.resolve(path.dirname(file)) });
    expect(error.message).toBe(T1(file, 'sync', path.resolve(path.dirname(file)), 'EIO'));
    expect(fs.readFileSync(file, 'utf8')).toBe('{"new":1}');
  });

  it('17: writeBackup with a failed chain throws FolderSyncError; the backup is in place', () => {
    const dir = dataPath('nb19', 'backups');
    failAt(dir);
    const error = thrown(() => writeBackup(dir, 'config', null, '{"b":1}')) as FolderSyncError;
    expect(error).toBeInstanceOf(FolderSyncError);
    expect(error.written).toBe(true);
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  it('18: the node id\'s first write throws once; the next call answers the same id and writes nothing', () => {
    const dir = dataPath('global', 'fleet');
    fs.rmSync(path.join(dir, 'node.json'), { force: true });
    failAt(dir);
    expect(thrown(() => getNodeId())).toBeInstanceOf(FolderSyncError);
    const id = JSON.parse(fs.readFileSync(path.join(dir, 'node.json'), 'utf8')).nodeId;
    const chains = h.chains.length;
    expect(getNodeId()).toBe(id);
    expect(h.chains.length).toBe(chains);
  });

  it('23: a mirror write passes chain false: no throw, no chain', () => {
    const file = dataPath('global', 'nb19-mirror.json');
    failAt(path.dirname(file));
    expect(() => atomicWriteFileSync(file, '{}', undefined, { chain: false })).not.toThrow();
    expect(h.chains).toEqual([]);
  });

  it('43: the shard record with a failed chain: no throw, T7 logged, the file holds the record', () => {
    failAt(path.dirname(shardRecordPath()));
    const record = { shardCount: 2, shardIds: [0], processId: 'p', at: '2026-11-10T00:00:00.000Z' };
    expect(() => writeShardRecord(record)).not.toThrow();
    expect(JSON.parse(fs.readFileSync(shardRecordPath(), 'utf8'))).toEqual(record);
    expect(errors).toEqual([`[Shards] The shard record can't be confirmed as saved: ${T1(shardRecordPath(), 'sync', path.resolve(path.dirname(shardRecordPath())), 'EIO')}`]);
  });

  it("43: three shard record writes from one EIO: T7 with the sync clause, then once with the earlier clause, then nothing", () => {
    const fleet = path.resolve(path.dirname(shardRecordPath()));
    failAt(fleet);
    const record = (at: string) => ({ shardCount: 2, shardIds: [0], processId: 'p', at });
    for (const at of ['2026-11-10T00:00:01.000Z', '2026-11-10T00:00:02.000Z', '2026-11-10T00:00:03.000Z']) {
      expect(() => writeShardRecord(record(at))).not.toThrow();
      expect(JSON.parse(fs.readFileSync(shardRecordPath(), 'utf8'))).toEqual(record(at));
    }
    const T7 = (kind: 'sync' | 'earlier') => `[Shards] The shard record can't be confirmed as saved: ${T1(shardRecordPath(), kind, fleet, 'EIO')}`;
    expect(errors).toEqual([T7('sync'), T7('earlier')]);
  });

  it('41: writeFileMarker logs T7 for the backend marker', () => {
    failAt(dataPath());
    writeFileMarker({ live: 'file', storeId: null, flippedAt: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith("[Data] The backend marker can't be confirmed as saved: ")).toBe(true);
    expect(errors[0]).not.toContain('Failed to write');
  });

  it('writeErrorText: T7 for a FolderSyncError, "could not be written" for any other error', () => {
    const error = thrown(() => { failAt(dataPath('nb19', 'w')); atomicWriteFileSync(dataPath('nb19', 'w', 'x.json'), '{}'); });
    expect(writeErrorText('The repeat check', error, ', so a repeat of this key may post again')).toBe(`The repeat check can't be confirmed as saved, so a repeat of this key may post again: ${(error as Error).message}`);
    expect(writeErrorText('The repeat check', new Error('ENOSPC: full'))).toBe('The repeat check could not be written: ENOSPC: full');
  });
});

describe('rows 19, 20, 34, 35 and 37: the App Store lists', () => {
  it('19: an install whose installed.json chain fails keeps the files and the entry and throws T9', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await new Promise(resolve => setTimeout(resolve, 50));
    failAt(STORE);
    const error = await rejected(() => m.installModule('alpha', 'official-modules')) as FolderSyncError;
    expect(error).toBeInstanceOf(FolderSyncError);
    expect(error.message).toBe(`Module alpha is installed, but the list of installed modules can't be confirmed as saved: ${T1(INSTALLED, 'sync', path.resolve(STORE), 'EIO')}`);
    expect(fs.existsSync(path.join(SOURCE, 'alpha', 'module.json'))).toBe(true);
    expect(installed().alpha).toMatchObject({ version: '1.0.0' });
    expect(m.isModuleInstalled('alpha')).toBe(true);
  });

  it('20: an install whose installed.json write fails before the rename removes the files with today\'s text', async () => {
    publish('alpha', '1.0.0');
    h.failRenameTo.add('installed.json');
    const error = await rejected(() => new AppStoreManager().installModule('alpha', 'official-modules')) as Error;
    expect(error).not.toBeInstanceOf(FolderSyncError);
    expect(error.message).toBe('Module alpha was not installed: the installed modules list could not be saved.');
    expect(fs.existsSync(path.join(SOURCE, 'alpha'))).toBe(false);
  });

  it('34: a repository add, update and remove with a failed chain: T11, the change in repos.json and in memory', async () => {
    const m = new AppStoreManager();
    failAt(STORE);
    const added = await rejected(async () => m.addRepository('extra', 'https://github.com/example/extra.git')) as FolderSyncError;
    expect(added).toBeInstanceOf(FolderSyncError);
    expect(added.message).toBe(`Repository extra is added, but the repository list can't be confirmed as saved: ${T1(REPOS, 'sync', path.resolve(STORE), 'EIO')}`);
    const repos = () => JSON.parse(fs.readFileSync(REPOS, 'utf8')).repositories as Array<{ id: string; name: string; branch: string }>;
    const id = repos().find(r => r.name === 'extra')!.id;
    expect(m.getRepository(id)?.name).toBe('extra');
    const updated = await rejected(async () => m.updateRepository(id, { branch: 'dev' })) as FolderSyncError;
    expect(updated.message).toBe(`Repository extra is updated, but the repository list can't be confirmed as saved: ${T1(REPOS, 'earlier', path.resolve(STORE), 'EIO')}`);
    expect(repos().find(r => r.id === id)?.branch).toBe('dev');
    expect(m.getRepository(id)?.branch).toBe('dev');
    fs.mkdirSync(path.join(STORE, 'cache', id), { recursive: true });
    const removed = await rejected(async () => m.removeRepository(id)) as FolderSyncError;
    expect(removed.message).toBe(`Repository extra is removed, but the repository list can't be confirmed as saved: ${T1(REPOS, 'earlier', path.resolve(STORE), 'EIO')}`);
    expect(repos().some(r => r.id === id)).toBe(false);
    expect(m.getRepository(id)).toBeNull();
    expect(m.getRepositories().some(r => r.id === id)).toBe(false);
    expect(fs.existsSync(path.join(STORE, 'cache', id))).toBe(false);
  });

  it('35: an update whose installed.json chain fails keeps the new version and its backup, and answers listUnconfirmed', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    publish('alpha', '1.1.0');
    failAt(STORE);
    const answer = await m.updateModule('alpha');
    expect(answer).toMatchObject({ success: true, newVersion: '1.1.0' });
    expect(answer.listUnconfirmed).toMatch(/^Module alpha is updated, but the list of installed modules can't be confirmed as saved: .* Its backup is kept at .*alpha-\d+\.$/);
    const backup = /Its backup is kept at (.*)\.$/.exec(answer.listUnconfirmed!)![1];
    expect(fs.existsSync(backup)).toBe(true);
    expect(installed().alpha.version).toBe('1.1.0');
    expect(JSON.parse(fs.readFileSync(path.join(SOURCE, 'alpha', 'module.json'), 'utf8')).version).toBe('1.1.0');
  });

  it('35: updateAllModules with the installed.json chain failing lists the module in updated with T9', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    publish('alpha', '1.1.0');
    failAt(STORE);
    const result = await m.updateAllModules();
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]).toMatchObject({ moduleName: 'alpha', newVersion: '1.1.0' });
    expect(result.updated[0].listUnconfirmed!.startsWith(`Module alpha is updated, but the list of installed modules can't be confirmed as saved: ${T1(INSTALLED, 'earlier', path.resolve(STORE), 'EIO')} Its backup is kept at `)).toBe(true);
    expect(result.success).toBe(false);
    expect(installed().alpha.version).toBe('1.1.0');
  });

  it('36: an update whose list rename lands but answers EIO, then a rollback save whose chain fails: previous files, backup kept, T10', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    publish('alpha', '1.1.0');
    h.renameLandsThenFails.add('installed.json');
    h.script.set(path.resolve(STORE), ['ok', { kind: 'sync', errno: 'EIO' }]);
    const answer = await m.updateModule('alpha');
    expect(answer.success).toBe(false);
    expect(h.renameLandsThenFails.size).toBe(0);
    const t1 = T1(INSTALLED, 'sync', path.resolve(STORE), 'EIO');
    const match = /^Install failed: the installed modules list could not be saved\. The previous version is back in place, but the list of installed modules can't be confirmed as saved: (.*) Its backup is kept at (.*)\.$/.exec(answer.error!);
    expect(match, answer.error).not.toBeNull();
    expect(match![1]).toBe(t1);
    const backup = match![2];
    expect(fs.existsSync(path.join(backup, 'module.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(SOURCE, 'alpha', 'module.json'), 'utf8')).version).toBe('1.0.0');
    expect(installed().alpha.version).toBe('1.0.0');
    expect(answer.error).not.toContain('could not be restored');
    expect(h.script.get(path.resolve(STORE))).toEqual([]);
  });

  it('36: an update whose list rename fails before it lands rolls back with no list save and no T10', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    publish('alpha', '1.1.0');
    h.failRenameTo.add('installed.json');
    const answer = await m.updateModule('alpha');
    expect(answer.success).toBe(false);
    expect(answer.error).toBe('Install failed: the installed modules list could not be saved');
    expect(JSON.parse(fs.readFileSync(path.join(SOURCE, 'alpha', 'module.json'), 'utf8')).version).toBe('1.0.0');
    expect(installed().alpha.version).toBe('1.0.0');
  });

  it('71: an install from a repository with no clone, whose refresh repos.json chain fails, goes on, logs T11, then answers T9 earlier', async () => {
    const m = new AppStoreManager();
    await new Promise(resolve => setTimeout(resolve, 50));
    const from = dataPath('nb19-clone-src');
    fs.rmSync(from, { recursive: true, force: true });
    write(path.join(from, 'Modules', 'alpha', 'module.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }));
    write(path.join(from, 'Modules', 'alpha', 'index.ts'), 'export {};');
    h.cloneFrom = from;
    h.script.set(path.resolve(STORE), [{ kind: 'sync', errno: 'EIO' }]);
    errors.length = 0;
    const error = await rejected(() => m.installModule('alpha', 'official-modules')) as FolderSyncError;
    expect(error).toBeInstanceOf(FolderSyncError);
    expect(error.message).toBe(`Module alpha is installed, but the list of installed modules can't be confirmed as saved: ${T1(INSTALLED, 'earlier', path.resolve(STORE), 'EIO')}`);
    expect(fs.readFileSync(path.join(SOURCE, 'alpha', 'index.ts'), 'utf8')).toBe('export {};');
    expect(installed().alpha).toMatchObject({ version: '1.0.0' });
    expect(errors).toContain(`[AppStoreManager] Repository Official Module Store is updated, but the repository list can't be confirmed as saved: ${T1(REPOS, 'sync', path.resolve(STORE), 'EIO')}`);
    expect(errors.some(e => e.includes('not found in repository') || e.includes('Failed to refresh repository'))).toBe(false);
  });

  it('71: three refreshes from one EIO on the store folder: T11 with the sync clause, then once with the earlier clause', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await new Promise(resolve => setTimeout(resolve, 50));
    failAt(STORE);
    errors.length = 0;
    const stamps: Array<string | undefined> = [];
    for (let i = 0; i < 3; i++) {
      const modules = await m.refreshRepository('official-modules');
      expect(modules.map(mod => mod.manifest.name)).toEqual(['alpha']);
      stamps.push((JSON.parse(fs.readFileSync(REPOS, 'utf8')).repositories as Array<{ id: string; lastRefreshed?: string }>).find(r => r.id === 'official-modules')?.lastRefreshed);
    }
    expect(stamps.every(stamp => typeof stamp === 'string')).toBe(true);
    const T11 = (kind: 'sync' | 'earlier') => `[AppStoreManager] Repository Official Module Store is updated, but the repository list can't be confirmed as saved: ${T1(REPOS, kind, path.resolve(STORE), 'EIO')}`;
    expect(errors).toEqual([T11('sync'), T11('earlier')]);
  });

  const T11_UPDATED = () => `[AppStoreManager] Repository Official Module Store is updated, but the repository list can't be confirmed as saved: ${T1(REPOS, 'sync', path.resolve(STORE), 'EIO')}`;
  const lastRefreshed = () => (JSON.parse(fs.readFileSync(REPOS, 'utf8')).repositories as Array<{ id: string; lastRefreshed?: string }>).find(r => r.id === 'official-modules')?.lastRefreshed;

  it('71: the update check whose refresh repos.json chain fails answers the update and logs T11', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    publish('alpha', '1.1.0');
    const before = lastRefreshed();
    await new Promise(resolve => setTimeout(resolve, 5));
    h.script.set(path.resolve(STORE), [{ kind: 'sync', errno: 'EIO' }]);
    errors.length = 0;
    const result = await m.checkAllModulesForUpdates();
    expect(result.errors).toEqual([]);
    expect(result.updates.find(u => u.moduleName === 'alpha')).toMatchObject({ hasUpdate: true });
    expect(errors).toContain(T11_UPDATED());
    expect(errors.some(e => e.includes('Failed to refresh repository'))).toBe(false);
    expect(lastRefreshed()).not.toBe(before);
    expect(h.script.get(path.resolve(STORE))).toEqual([]);
  });

  it('71: the refresh route whose repos.json chain fails answers its modules and logs T11', async () => {
    publish('alpha', '1.0.0');
    const manager = getAppStoreManager();
    await new Promise(resolve => setTimeout(resolve, 50));
    const router = createAppStoreRoutes({} as never) as any;
    const layer = router.stack.find((l: any) => l.route?.path === '/repos/:id/refresh' && l.route.methods.post);
    const res: any = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (body: any) => { res.body = body; return res; };
    expect(manager.getRepository('official-modules')).toBeTruthy();
    h.script.set(path.resolve(STORE), [{ kind: 'sync', errno: 'EIO' }]);
    errors.length = 0;
    await layer.route.stack[0].handle({ params: { id: 'official-modules' }, body: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.modules.map((x: { name: string }) => x.name)).toContain('alpha');
    expect(errors).toContain(T11_UPDATED());
    expect(errors.some(e => e.includes('Failed to refresh repository'))).toBe(false);
    expect(lastRefreshed()).toBeDefined();
    expect(h.script.get(path.resolve(STORE))).toEqual([]);
  });

  it('38: the load with a missing repos.json and a failed chain logs T7, no "Failed to load config"', async () => {
    failAt(STORE);
    new AppStoreManager();
    await vi.waitFor(() => expect(errors).toContain(`[AppStoreManager] The repos config can't be confirmed as saved: ${T1(REPOS, 'sync', path.resolve(STORE), 'EIO')}`), { timeout: 3000, interval: 10 });
    expect(JSON.parse(fs.readFileSync(REPOS, 'utf8')).repositories.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('Failed to load config'))).toBe(false);
  });

  it('38: the reconcile of a stale entry with a failed chain logs T7 and the file loses the entry', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    fs.rmSync(path.join(SOURCE, 'alpha'), { recursive: true, force: true });
    failAt(STORE);
    errors.length = 0;
    new AppStoreManager();
    await vi.waitFor(() => expect(errors).toContain(`[AppStoreManager] The installed config can't be confirmed as saved: ${T1(INSTALLED, 'sync', path.resolve(STORE), 'EIO')}`), { timeout: 3000, interval: 10 });
    expect(installed().alpha).toBeUndefined();
    expect(errors.some(e => e.includes('Failed to load config') || e.includes('could not be written'))).toBe(false);
  });

  it('37: an uninstall whose installed.json chain fails removes the files and throws T9', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    failAt(STORE);
    const error = await rejected(() => m.uninstallModule('alpha')) as FolderSyncError;
    expect(error).toBeInstanceOf(FolderSyncError);
    expect(error.message.startsWith("Module alpha is uninstalled, but the list of installed modules can't be confirmed as saved: ")).toBe(true);
    expect(fs.existsSync(path.join(SOURCE, 'alpha'))).toBe(false);
    expect(installed().alpha).toBeUndefined();
  });

  it('79: a repository add whose folder open fails answers T11 with the open clause and stores it once', async () => {
    const m = new AppStoreManager();
    failAt(STORE, 'EMFILE', 'open');
    const added = await rejected(async () => m.addRepository('extra', 'https://github.com/example/extra.git')) as FolderSyncError;
    expect(added.message).toContain('could not be opened for its sync (EMFILE)');
    expect(added.message).toContain('check the current state before you repeat the action');
    expect(added.message).not.toContain('Try again.');
    expect(JSON.parse(fs.readFileSync(REPOS, 'utf8')).repositories.filter((r: { name: string }) => r.name === 'extra')).toHaveLength(1);
  });

  it('79: POST /repos whose folder open fails answers 500 with T11 added and the open clause, stored once', async () => {
    const manager = getAppStoreManager();
    await new Promise(resolve => setTimeout(resolve, 50));
    vi.spyOn(manager, 'testRepoAccess').mockReturnValue({ ok: true });
    const router = createAppStoreRoutes({} as never) as any;
    const layer = router.stack.find((l: any) => l.route?.path === '/repos' && l.route.methods.post);
    const res: any = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (body: any) => { res.body = body; return res; };
    failAt(STORE, 'EMFILE', 'open');
    await layer.route.stack[0].handle({ params: {}, body: { name: 'extra', url: 'https://github.com/example/extra.git' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: `Repository extra is added, but the repository list can't be confirmed as saved: ${T1(REPOS, 'open', path.resolve(STORE), 'EMFILE')}`,
    });
    expect(res.body.error).not.toContain('Try again.');
    expect(JSON.parse(fs.readFileSync(REPOS, 'utf8')).repositories.filter((r: { name: string }) => r.name === 'extra')).toHaveLength(1);
  });
});

describe('rows 68 and 72: the install queue and the bulk update text', () => {
  async function runJob(queue: InstallQueue, job: { id: string }): Promise<any> {
    for (let i = 0; i < 400; i++) {
      const found = (queue as any).jobs.find((j: { id: string }) => j.id === job.id);
      if (found && (found.status === 'failed' || found.status === 'completed')) return found;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('the job did not end');
  }

  it('68: an install and an uninstall whose list chain fails load or unload the module, then fail with T9', async () => {
    const manager = getAppStoreManager();
    const t9 = Object.assign(new FolderSyncError(INSTALLED, { failed: true, kind: 'sync', dir: STORE, errno: 'EIO', error: null }), {});
    t9.message = 'Module alpha is installed, but the list of installed modules can\'t be confirmed as saved: x';
    vi.spyOn(manager, 'isModuleInstalled').mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.spyOn(manager, 'installModule').mockRejectedValue(t9);
    const loadModule = vi.fn(async () => ({ success: true }));
    const unloadModule = vi.fn(async () => ({ success: true }));
    const queue = new InstallQueue();
    queue.setBotManager({ loadModule, unloadModule } as any);
    (queue as any).storeDocsFirst = async () => undefined;
    const job = await runJob(queue, queue.enqueueInstall('alpha', 'official-modules'));
    expect(loadModule).toHaveBeenCalledWith('alpha');
    expect(job).toMatchObject({ status: 'failed', error: t9.message, loaded: true });

    const u9 = new FolderSyncError(INSTALLED, { failed: true, kind: 'sync', dir: STORE, errno: 'EIO', error: null });
    u9.message = 'Module alpha is uninstalled, but the list of installed modules can\'t be confirmed as saved: x';
    vi.spyOn(manager, 'uninstallModule').mockRejectedValue(u9);
    fs.mkdirSync(STORE, { recursive: true });
    fs.writeFileSync(componentConfigPath(), JSON.stringify({ 'alpha:command:a': false, 'beta:command:b': false }, null, 2));
    const ujob = await runJob(queue, queue.enqueueUninstall('alpha'));
    expect(unloadModule).toHaveBeenCalledWith('alpha');
    expect(ujob).toMatchObject({ status: 'failed', error: u9.message, unloaded: true });
    expect(JSON.parse(fs.readFileSync(componentConfigPath(), 'utf8'))).toEqual({ 'beta:command:b': false });
  });

  it('51: an uninstall whose component toggles cleanup chain fails: the file loses the keys, T7, the job completes', async () => {
    const manager = getAppStoreManager();
    fs.mkdirSync(STORE, { recursive: true });
    fs.writeFileSync(componentConfigPath(), JSON.stringify({ 'alpha:command:a': false, 'beta:command:b': false }, null, 2));
    vi.spyOn(manager, 'isModuleInstalled').mockReturnValue(true);
    vi.spyOn(manager, 'uninstallModule').mockResolvedValue(true);
    const unloadModule = vi.fn(async () => ({ success: true }));
    const queue = new InstallQueue();
    queue.setBotManager({ unloadModule } as any);
    (queue as any).storeDocsFirst = async () => undefined;
    failAt(STORE);
    errors.length = 0;
    const job = await runJob(queue, queue.enqueueUninstall('alpha'));
    expect(unloadModule).toHaveBeenCalledWith('alpha');
    expect(job).toMatchObject({ status: 'completed', unloaded: true });
    expect(JSON.parse(fs.readFileSync(componentConfigPath(), 'utf8'))).toEqual({ 'beta:command:b': false });
    expect(errors).toEqual([`[AppStore] The component toggles cleanup of alpha can't be confirmed as saved: ${T1(componentConfigPath(), 'sync', path.resolve(STORE), 'EIO')}`]);
    expect(errors.some(e => e.includes('could not be written') || e.includes('failed'))).toBe(false);
  });

  it('68: an install whose list write fails before the rename keeps today\'s path: no load', async () => {
    const manager = getAppStoreManager();
    vi.spyOn(manager, 'isModuleInstalled').mockReturnValue(false);
    vi.spyOn(manager, 'installModule').mockRejectedValue(new Error('Module beta was not installed: the installed modules list could not be saved.'));
    const loadModule = vi.fn(async () => ({ success: true }));
    const queue = new InstallQueue();
    queue.setBotManager({ loadModule } as any);
    (queue as any).storeDocsFirst = async () => undefined;
    const job = await runJob(queue, queue.enqueueInstall('beta', 'official-modules'));
    expect(loadModule).not.toHaveBeenCalled();
    expect(job.status).toBe('failed');
  });

  it('68: an uninstall whose list write fails before the rename keeps the path of today: no unload, the toggles kept', async () => {
    const manager = getAppStoreManager();
    fs.mkdirSync(STORE, { recursive: true });
    const toggles = JSON.stringify({ 'beta:command:b': false }, null, 2);
    fs.writeFileSync(componentConfigPath(), toggles);
    const plain = new Error('Module beta was not uninstalled: the installed modules list could not be saved.');
    vi.spyOn(manager, 'isModuleInstalled').mockReturnValue(true);
    vi.spyOn(manager, 'uninstallModule').mockRejectedValue(plain);
    const unloadModule = vi.fn(async () => ({ success: true }));
    const queue = new InstallQueue();
    queue.setBotManager({ unloadModule } as any);
    (queue as any).storeDocsFirst = async () => undefined;
    const job = await runJob(queue, queue.enqueueUninstall('beta'));
    expect(unloadModule).not.toHaveBeenCalled();
    expect(job).toMatchObject({ status: 'failed', error: plain.message });
    expect(job.unloaded).not.toBe(true);
    expect(fs.readFileSync(componentConfigPath(), 'utf8')).toBe(toggles);
  });

  it('72 and 40: the bulk text ends with T9 and its backup; the bulk answer is not a success', async () => {
    const t9 = 'Module alpha is updated, but the list of installed modules can\'t be confirmed as saved: x Its backup is kept at /b/alpha-1.';
    const result: BulkModuleUpdateResult = {
      success: false, totalAttempted: 1, totalUpdated: 1,
      updated: [{ moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '1.1.0', listUnconfirmed: t9 }],
      failed: [], checkErrors: [], skipped: [],
    };
    expect(describeBulkModuleUpdate(result)).toBe(`Updated 1 module(s). ${t9}`);
    expect(describeBulkModuleUpdate(result, 'reloaded the updated module(s)')).toBe(`Updated 1 module(s); reloaded the updated module(s). ${t9}`);
    const manager = getAppStoreManager();
    vi.spyOn(manager, 'updateAllModules').mockResolvedValue({ success: false, updated: result.updated, failed: [], checkErrors: [], skipped: [] });
    expect((await triggerAllModuleUpdates()).success).toBe(false);
  });
});
