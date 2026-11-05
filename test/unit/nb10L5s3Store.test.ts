import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The App Store lock: which instance may save, and what a section nested in a held lock leaves behind.

const h = vi.hoisted(() => ({ fetchHook: null as null | (() => void), snapshotHook: null as null | (() => void) }));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const fsReal = await vi.importActual<any>('fs');
  const execSync = (cmd: string, opts: any = {}) => {
    if (cmd.startsWith('git rev-parse HEAD')) {
      return Buffer.from(fsReal.readFileSync(path.join(opts.cwd, '.git', 'HEAD_HASH'), 'utf-8'));
    }
    if (cmd.startsWith('git remote set-url')) return Buffer.from('');
    if (cmd.startsWith('git fetch')) {
      const hook = h.fetchHook;
      h.fetchHook = null;
      hook?.();
      return Buffer.from('');
    }
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({
  takeAutoSnapshot: () => {
    const hook = h.snapshotHook;
    h.snapshotHook = null;
    hook?.();
  },
}));

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
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';

const STORE = dataPath('global', 'appstore');
const CACHE = path.join(STORE, 'cache');
const INSTALLED = path.join(STORE, 'installed.json');
const REPOS = path.join(STORE, 'repos.json');
const CLONE = path.join(CACHE, 'official-modules');
const SOURCE = dataPath('appstore-modules');
const BUILD = dataPath('build-modules');
const REPO_ID = 'official-modules';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function publish(name: string, version: string): void {
  write(path.join(CLONE, 'Modules', name, 'module.json'), JSON.stringify({ name, version }));
  write(path.join(CLONE, 'Modules', name, 'index.ts'), 'export {};');
  write(path.join(CLONE, '.git', 'HEAD_HASH'), 'a'.repeat(40));
}

type Saves = { saveRepos(): boolean; saveInstalled(): boolean };
const saves = (m: AppStoreManager) => m as unknown as Saves;

beforeEach(() => {
  for (const dir of [STORE, SOURCE, BUILD, dataPath('runtime-modules')]) fs.rmSync(dir, { recursive: true, force: true });
  h.fetchHook = null;
  h.snapshotHook = null;
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a section nested in a held store lock', () => {
  it('creates no cache folder when the lock is taken again inside a held section', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    let cacheBack: boolean | undefined;
    h.fetchHook = () => {
      fs.rmSync(CACHE, { recursive: true, force: true });
      m.addRepository('Extra', 'https://github.com/someone/extra-modules');
      cacheBack = fs.existsSync(CACHE);
    };
    await m.refreshRepository(REPO_ID).catch(() => undefined);
    expect(cacheBack).toBe(false);
  });

  it('an install still saves its record after a nested uninstall ran inside it', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    h.snapshotHook = () => { void m.uninstallModule('ghost').catch(() => undefined); };
    await expect(m.installModule('alpha', REPO_ID)).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(INSTALLED, 'utf-8')).modules.alpha.version).toBe('1.0.0');
  });

  it('an install still saves its record after a nested update ran inside it', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    let nested: unknown;
    h.snapshotHook = () => { void m.updateModule('ghost').then(r => { nested = r; }); };
    await expect(m.installModule('alpha', REPO_ID)).resolves.toBe(true);
    expect(nested).toEqual({ success: false, error: 'Module ghost is not installed' });
    expect(JSON.parse(fs.readFileSync(INSTALLED, 'utf-8')).modules.alpha.version).toBe('1.0.0');
  });

  it('a getter called inside a held section keeps the list read under the lock', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    let seen: string[] = [];
    h.fetchHook = () => {
      const cur = JSON.parse(fs.readFileSync(REPOS, 'utf-8'));
      cur.repositories.push({ ...cur.repositories[0], id: 'zeta', name: 'Zeta' });
      write(REPOS, JSON.stringify(cur));
      seen = m.getRepositories().map(r => r.id);
    };
    await m.refreshRepository(REPO_ID);
    expect(seen).toContain(REPO_ID);
    expect(seen).not.toContain('zeta');
  });
});

describe('a save is refused unless this instance read the file under the lock it holds now', () => {
  it('refuses an instance whose reads were made under a lock that has since been released', async () => {
    publish('alpha', '1.0.0');
    const holder = new AppStoreManager();
    const viaLocked = new AppStoreManager();
    const viaAsync = new AppStoreManager();
    await viaAsync.uninstallModule('ghost').catch(() => undefined);
    const viaUpdate = new AppStoreManager();
    await viaUpdate.updateModule('ghost');
    let answers: Record<string, boolean> = {};
    h.fetchHook = () => {
      answers = {
        lockedRepos: saves(viaLocked).saveRepos(),
        lockedInstalled: saves(viaLocked).saveInstalled(),
        asyncInstalled: saves(viaAsync).saveInstalled(),
        updateRepos: saves(viaUpdate).saveRepos(),
        updateInstalled: saves(viaUpdate).saveInstalled(),
      };
    };
    await holder.refreshRepository(REPO_ID);
    expect(answers).toEqual({ lockedRepos: false, lockedInstalled: false, asyncInstalled: false, updateRepos: false, updateInstalled: false });
    expect(fs.existsSync(INSTALLED)).toBe(false);
  });

  it('refuses, once the lock is released, an instance that read inside another instance\'s held section', async () => {
    publish('alpha', '1.0.0');
    const holder = new AppStoreManager();
    const m = new AppStoreManager();
    h.fetchHook = () => {
      expect(m.updateRepository('nope', {})).toBe(false);
      void m.uninstallModule('ghost').catch(() => undefined);
    };
    await holder.refreshRepository(REPO_ID);
    const repos = fs.readFileSync(REPOS, 'utf-8');
    expect([saves(m).saveRepos(), saves(m).saveInstalled()]).toEqual([false, false]);
    expect(fs.readFileSync(REPOS, 'utf-8')).toBe(repos);
    expect(fs.existsSync(INSTALLED)).toBe(false);
  });

  it('refuses an instance whose last read was made without the lock', async () => {
    publish('alpha', '1.0.0');
    const holder = new AppStoreManager();
    const m = new AppStoreManager();
    write(REPOS, JSON.stringify(JSON.parse(fs.readFileSync(REPOS, 'utf-8')), null, 4));
    write(INSTALLED, JSON.stringify({ modules: {} }, null, 4));
    expect(m.getRepositories().map(r => r.id)).toContain(REPO_ID);
    expect(m.getInstalledModules()).toEqual([]);
    let answers: boolean[] = [];
    h.fetchHook = () => { answers = [saves(m).saveRepos(), saves(m).saveInstalled()]; };
    await holder.refreshRepository(REPO_ID);
    expect(answers).toEqual([false, false]);
    expect(fs.readFileSync(INSTALLED, 'utf-8')).toBe(JSON.stringify({ modules: {} }, null, 4));
  });

  it('refuses an instance that read repos.json unreadable under the lock, and the file keeps its bytes', async () => {
    publish('alpha', '1.0.0');
    const holder = new AppStoreManager();
    const m = new AppStoreManager();
    const garbage = '{"repositories": not json';
    let updated: boolean | undefined;
    let saved: boolean | undefined;
    let after = '';
    h.fetchHook = () => {
      write(REPOS, garbage);
      updated = m.updateRepository('nope', {});
      saved = saves(m).saveRepos();
      after = fs.readFileSync(REPOS, 'utf-8');
    };
    await holder.refreshRepository(REPO_ID);
    expect(updated).toBe(false);
    expect(saved).toBe(false);
    expect(after).toBe(garbage);
  });
});
