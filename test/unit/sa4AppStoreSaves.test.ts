import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fail: new Map<string, { kind: 'sync'; errno: string }>(),
  failRenameTo: new Set<string>(),
  landThenFailAll: new Set<string>(),
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChainSync: (dir: string) => {
      const at = path.resolve(dir);
      const f = h.fail.get(at);
      if (!f) return { failed: false };
      return { failed: true, kind: f.kind, dir: at, errno: f.errno, error: null };
    },
  };
});

vi.mock('fs', async orig => {
  const real = await orig<any>();
  const wrapped = {
    ...real,
    renameSync: (from: any, to: any) => {
      const base = path.basename(String(to));
      if (h.failRenameTo.has(base)) throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
      if (h.landThenFailAll.delete(base)) {
        real.renameSync(from, to);
        h.failRenameTo.add(base);
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
import { FolderSyncError, syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';

const STORE = dataPath('global', 'appstore');
const INSTALLED = path.join(STORE, 'installed.json');
const REPOS = path.join(STORE, 'repos.json');
const CLONE = path.join(STORE, 'cache', 'official-modules');
const SOURCE = dataPath('appstore-modules');
const BUILD = dataPath('build-modules');

const T1 = (file: string, dir: string, errno: string) => {
  const { why, next } = syncWords('sync', dir, errno);
  return `${file} is written, but ${why}, so can't confirm it is stored. ${next}`;
};
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function publish(name: string, version: string): void {
  write(path.join(CLONE, 'Modules', name, 'module.json'), JSON.stringify({ name, version }));
  write(path.join(CLONE, 'Modules', name, 'index.ts'), 'export {};');
  write(path.join(CLONE, '.git', 'HEAD_HASH'), 'a'.repeat(40));
}
const entry = (name: string) => ({ name, version: '1.0.0', installedFrom: 'official-modules', installedAt: '2026-11-16T00:00:00.000Z', commitHash: 'a'.repeat(40) });
const installed = (): Record<string, any> => JSON.parse(fs.readFileSync(INSTALLED, 'utf-8')).modules;
const repoIds = (): string[] => (JSON.parse(fs.readFileSync(REPOS, 'utf8')).repositories as Array<{ id: string }>).map(r => r.id);
async function rejected(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  return undefined;
}
function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  return undefined;
}

let errorCalls: unknown[][];
beforeEach(() => {
  h.fail.clear();
  h.failRenameTo.clear();
  h.landThenFailAll.clear();
  errorCalls = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errorCalls.push(args); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  for (const dir of [STORE, SOURCE, BUILD, dataPath('runtime-modules')]) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

describe('the App Store reconcile at load', () => {
  it('with every listed module on disk and no orphan, installed.json is not written again', () => {
    new AppStoreManager();
    const bytes = JSON.stringify({ modules: { alpha: entry('alpha') } });
    write(INSTALLED, bytes);
    write(path.join(SOURCE, 'alpha', 'module.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }));
    const m = new AppStoreManager();
    expect(m.isModuleInstalled('alpha')).toBe(true);
    expect(fs.readFileSync(INSTALLED, 'utf8')).toBe(bytes);
  });
});

describe('the repository list when its write fails before the rename lands', () => {
  it('an add throws the not added text, and the repository is neither in memory nor in repos.json', () => {
    const m = new AppStoreManager();
    const before = repoIds();
    h.failRenameTo.add('repos.json');
    const error = thrown(() => m.addRepository('extra', 'https://github.com/example/extra.git')) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(FolderSyncError);
    expect(error.message).toBe('The repository list could not be saved, so the repository was not added.');
    expect(m.getRepositories().some(r => r.name === 'extra')).toBe(false);
    expect(repoIds()).toEqual(before);
    expect(errorCalls.some(c => c[0] === '[AppStoreManager] Failed to save repos config:')).toBe(true);
  });

  it('a remove answers false, keeps the repository in memory and in repos.json, and keeps its cached clone', () => {
    const m = new AppStoreManager();
    fs.mkdirSync(path.join(STORE, 'cache', 'official-modules'), { recursive: true });
    h.failRenameTo.add('repos.json');
    expect(m.removeRepository('official-modules')).toBe(false);
    expect(repoIds()).toContain('official-modules');
    expect(m.getRepository('official-modules')).not.toBeNull();
    expect(fs.existsSync(path.join(STORE, 'cache', 'official-modules'))).toBe(true);
  });
});

describe('an uninstall and the installed modules list', () => {
  it('a list write that fails before the rename: the not uninstalled text, the files and the entry stay', async () => {
    new AppStoreManager();
    write(INSTALLED, JSON.stringify({ modules: { alpha: entry('alpha') } }));
    write(path.join(SOURCE, 'alpha', 'module.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }));
    write(path.join(BUILD, 'alpha', 'module.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }));
    const m = new AppStoreManager();
    h.failRenameTo.add('installed.json');
    const error = await rejected(() => m.uninstallModule('alpha')) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Module alpha was not uninstalled: the installed modules list could not be saved.');
    expect(fs.existsSync(path.join(SOURCE, 'alpha', 'module.json'))).toBe(true);
    expect(fs.existsSync(path.join(BUILD, 'alpha', 'module.json'))).toBe(true);
    expect(installed().alpha).toBeDefined();
  });

  it('a module with no files whose list chain fails: T9 for uninstalled, and the entry is gone from installed.json', async () => {
    new AppStoreManager();
    write(INSTALLED, JSON.stringify({ modules: { ghost: entry('ghost') } }));
    const m = new AppStoreManager();
    expect(m.isModuleInstalled('ghost')).toBe(true);
    h.fail.set(path.resolve(STORE), { kind: 'sync', errno: 'EIO' });
    const error = await rejected(() => m.uninstallModule('ghost')) as FolderSyncError;
    expect(error).toBeInstanceOf(FolderSyncError);
    expect(error.message).toBe(`Module ghost is uninstalled, but the list of installed modules can't be confirmed as saved: ${T1(INSTALLED, path.resolve(STORE), 'EIO')}`);
    expect(installed().ghost).toBeUndefined();
  });
});

describe('an update whose rollback cannot save the list', () => {
  it('the rollback failure is logged with the list text, and the answer says the previous version could not be restored', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    publish('alpha', '1.1.0');
    h.landThenFailAll.add('installed.json');
    errorCalls.length = 0;
    const answer = await m.updateModule('alpha');
    expect(answer.success).toBe(false);
    expect(answer.error).toMatch(/^Install failed: the installed modules list could not be saved\. The previous version could not be restored; its backup is at .+$/);
    const rollback = errorCalls.filter(c => c[0] === '[AppStoreManager] Rollback failed:');
    expect(rollback).toHaveLength(1);
    expect((rollback[0][1] as Error).message).toBe('the installed modules list could not be saved');
  });
});
