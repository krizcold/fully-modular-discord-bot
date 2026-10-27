import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  failRenameTo: new Set<string>(),
  fsyncs: 0,
  renamesTo: [] as string[],
  execs: [] as { cmd: string; timeout: unknown }[],
  lockOnGuardOpen: null as string | null,
}));

vi.mock('fs', async (orig) => {
  const real = await orig<any>();
  const wrapped = {
    ...real,
    renameSync: (from: any, to: any) => {
      h.renamesTo.push(path.basename(String(to)));
      if (h.failRenameTo.has(path.basename(String(to)))) {
        throw Object.assign(new Error(`EIO: i/o error, rename '${from}'`), { code: 'EIO' });
      }
      return real.renameSync(from, to);
    },
    fsyncSync: (fd: any) => { h.fsyncs++; return real.fsyncSync(fd); },
    openSync: (file: any, flags: any, ...rest: any[]) => {
      if (h.lockOnGuardOpen !== null && flags === 'wx' && path.basename(String(file)) === '.store.lock.takeover') {
        real.writeFileSync(String(file).slice(0, -'.takeover'.length), h.lockOnGuardOpen);
        h.lockOnGuardOpen = null;
      }
      return real.openSync(file, flags, ...rest);
    },
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('child_process', async (orig) => {
  const real = await orig<any>();
  const fsReal = await vi.importActual<any>('fs');
  const execSync = (cmd: string, opts: any = {}) => {
    h.execs.push({ cmd, timeout: opts.timeout });
    if (cmd.startsWith('git rev-parse HEAD')) {
      return Buffer.from(fsReal.readFileSync(path.join(opts.cwd, '.git', 'HEAD_HASH'), 'utf-8'));
    }
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

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async (orig) => {
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
import { AppStoreManager, storeLockHolder } from '../../src/bot/internalSetup/utils/appStoreManager';

const STORE = dataPath('global', 'appstore');
const INSTALLED = path.join(STORE, 'installed.json');
const REPOS = path.join(STORE, 'repos.json');
const CLONE = path.join(STORE, 'cache', 'official-modules');
const SOURCE = dataPath('appstore-modules');
const BUILD = dataPath('build-modules');
const LOCK = path.join(STORE, 'cache', '.store.lock');
const GUARD = `${LOCK}.takeover`;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function publish(name: string, version: string, body = 'export {};'): void {
  write(path.join(CLONE, 'Modules', name, 'module.json'), JSON.stringify({ name, version }));
  write(path.join(CLONE, 'Modules', name, 'index.ts'), body);
}

function setHead(hash: string): void {
  write(path.join(CLONE, '.git', 'HEAD_HASH'), hash);
}

function installedOnDisk(): Record<string, any> {
  return JSON.parse(fs.readFileSync(INSTALLED, 'utf-8')).modules;
}

function repoIdsOnDisk(): string[] {
  return JSON.parse(fs.readFileSync(REPOS, 'utf-8')).repositories.map((r: any) => r.id);
}

function placeInstalled(name: string, version: string): void {
  write(path.join(SOURCE, name, 'module.json'), JSON.stringify({ name, version }));
  write(path.join(SOURCE, name, 'index.ts'), 'export {};');
}

beforeEach(() => {
  for (const dir of [STORE, SOURCE, BUILD, dataPath('runtime-modules')]) fs.rmSync(dir, { recursive: true, force: true });
  h.failRenameTo.clear();
  h.fsyncs = 0;
  h.renamesTo = [];
  h.execs = [];
  h.lockOnGuardOpen = null;
  vi.restoreAllMocks();
  setHead('a'.repeat(40));
});

describe('C16-1 the App Store files have one writer at a time', () => {
  it('a web UI install during a child auto-update keeps both records', async () => {
    publish('alpha', '1.0.0');
    publish('beta', '1.0.0');
    const child = new AppStoreManager();
    await child.installModule('alpha', 'official-modules');
    const webui = new AppStoreManager();
    publish('alpha', '2.0.0');
    setHead('b'.repeat(40));
    await webui.installModule('beta', 'official-modules');
    const result = await child.updateModule('alpha');
    expect(result.success).toBe(true);
    const modules = installedOnDisk();
    expect(Object.keys(modules).sort()).toEqual(['alpha', 'beta']);
    expect(modules.alpha.version).toBe('2.0.0');
  });

  it('a module uninstalled in the web UI is not copied back at its next version bump', async () => {
    publish('alpha', '1.0.0');
    const child = new AppStoreManager();
    await child.installModule('alpha', 'official-modules');
    const webui = new AppStoreManager();
    await webui.uninstallModule('alpha');
    publish('alpha', '2.0.0');
    const result = await child.updateModule('alpha');
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(SOURCE, 'alpha'))).toBe(false);
    expect(fs.existsSync(path.join(BUILD, 'alpha'))).toBe(false);
    expect(installedOnDisk().alpha).toBeUndefined();
  });

  it('a module whose files are gone is not updated', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    fs.rmSync(path.join(SOURCE, 'alpha'), { recursive: true, force: true });
    publish('alpha', '2.0.0');
    const result = await m.updateModule('alpha');
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(SOURCE, 'alpha'))).toBe(false);
  });

  it('a repository removed in the web UI stays removed after a child update check', async () => {
    publish('alpha', '1.0.0');
    const child = new AppStoreManager();
    await child.installModule('alpha', 'official-modules');
    const webui = new AppStoreManager();
    expect(webui.removeRepository('official-modules')).toBe(true);
    await child.checkAllModulesForUpdates();
    await child.refreshRepository('official-modules').catch(() => undefined);
    expect(repoIdsOnDisk()).not.toContain('official-modules');
  });

  it('a repository added in the web UI stays after a child update check', async () => {
    publish('alpha', '1.0.0');
    const child = new AppStoreManager();
    await child.installModule('alpha', 'official-modules');
    const webui = new AppStoreManager();
    const added = webui.addRepository('Extra', 'https://github.com/example/extra', 'main');
    await child.checkAllModulesForUpdates();
    expect(repoIdsOnDisk()).toContain(added.id);
  });

  it('the other process sees a change at its next read', async () => {
    publish('gamma', '1.0.0');
    write(INSTALLED, JSON.stringify({ modules: {} }));
    const child = new AppStoreManager();
    const webui = new AppStoreManager();
    await webui.installModule('gamma', 'official-modules');
    expect(child.isModuleInstalled('gamma')).toBe(true);
    expect(child.getInstalledModules().map(m => m.name)).toEqual(['gamma']);
  });
});

describe('C16-1 installed.json and repos.json load strictly', () => {
  it('an unreadable installed.json is kept, copied aside, and blocks installs and the reconcile', async () => {
    placeInstalled('alpha', '1.0.0');
    publish('beta', '1.0.0');
    write(INSTALLED, '{"modules": {"alpha": {"name": "al');
    const before = fs.readFileSync(INSTALLED, 'utf-8');
    const m = new AppStoreManager();
    expect(fs.existsSync(path.join(SOURCE, 'alpha'))).toBe(true);
    await expect(m.installModule('beta', 'official-modules')).rejects.toThrow(/could not be read/);
    expect(fs.readFileSync(INSTALLED, 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(SOURCE, 'beta'))).toBe(false);
    const aside = path.join(STORE, 'cache', 'unreadable');
    expect(fs.readdirSync(aside).some(f => f.startsWith('installed.json'))).toBe(true);
  });

  it('an unreadable repos.json is kept and blocks a repository change', () => {
    write(REPOS, '{"repositories": [{"id": "x"');
    const before = fs.readFileSync(REPOS, 'utf-8');
    const m = new AppStoreManager();
    expect(() => m.addRepository('Extra', 'https://github.com/example/extra', 'main')).toThrow(/could not be read/);
    expect(m.updateRepository('x', { name: 'y' })).toBe(false);
    expect(fs.readFileSync(REPOS, 'utf-8')).toBe(before);
  });

  it('a missing installed.json never deletes module folders', () => {
    placeInstalled('gamma', '1.0.0');
    new AppStoreManager();
    new AppStoreManager();
    expect(fs.existsSync(path.join(SOURCE, 'gamma'))).toBe(true);
  });

  it('a readable installed.json still removes a folder it does not list', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    placeInstalled('stray', '1.0.0');
    new AppStoreManager();
    expect(fs.existsSync(path.join(SOURCE, 'stray'))).toBe(false);
    expect(fs.existsSync(path.join(SOURCE, 'alpha'))).toBe(true);
  });

  it('writes go through an fsynced temp file and a rename', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    expect(h.renamesTo).toContain('installed.json');
    expect(h.fsyncs).toBeGreaterThan(0);
    expect(fs.readdirSync(STORE).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('an install whose record cannot be written fails and leaves no files', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    h.failRenameTo.add('installed.json');
    await expect(m.installModule('alpha', 'official-modules')).rejects.toThrow();
    expect(fs.existsSync(path.join(SOURCE, 'alpha'))).toBe(false);
    expect(m.isModuleInstalled('alpha')).toBe(false);
  });

  it('a lock left by a dead process does not block, and no lock stays behind', async () => {
    publish('alpha', '1.0.0');
    write(path.join(STORE, 'cache', '.store.lock'), JSON.stringify({ pid: 2147483646, at: Date.now() }));
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    expect(installedOnDisk().alpha).toBeDefined();
    expect(fs.existsSync(path.join(STORE, 'cache', '.store.lock'))).toBe(false);
  });
});

describe('C16-1 the store lock between the web UI and the bot child', () => {
  it('a wait for the other process does not block the event loop', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    write(LOCK, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    let lockSeenByTimer: boolean | undefined;
    setTimeout(() => {
      lockSeenByTimer = fs.existsSync(LOCK);
      fs.rmSync(LOCK, { force: true });
    }, 200);
    await m.installModule('alpha', 'official-modules');
    expect(lockSeenByTimer).toBe(true);
    expect(installedOnDisk().alpha).toBeDefined();
  }, 10_000);

  it('a lock whose pid now belongs to a new process is taken over', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    vi.spyOn(storeLockHolder, 'startOf').mockReturnValue('run-2');
    write(LOCK, JSON.stringify({ pid: process.ppid, start: 'run-1', at: Date.now() }));
    await m.installModule('alpha', 'official-modules');
    expect(installedOnDisk().alpha).toBeDefined();
    expect(fs.existsSync(LOCK)).toBe(false);
  }, 10_000);

  it('a lock held by the same live process run still blocks', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    vi.spyOn(storeLockHolder, 'startOf').mockReturnValue('run-1');
    const held = JSON.stringify({ pid: process.ppid, start: 'run-1', at: Date.now() });
    write(LOCK, held);
    let lockSeenByTimer: string | undefined;
    setTimeout(() => {
      lockSeenByTimer = fs.readFileSync(LOCK, 'utf-8');
      fs.rmSync(LOCK, { force: true });
    }, 200);
    await m.installModule('alpha', 'official-modules');
    expect(lockSeenByTimer).toBe(held);
  }, 10_000);

  it('a stale lock is not taken over while another process holds the takeover guard', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    const dead = JSON.stringify({ pid: 2147483646, at: Date.now() });
    write(LOCK, dead);
    write(GUARD, '');
    let lockSeenByTimer: string | null | undefined;
    setTimeout(() => {
      lockSeenByTimer = fs.existsSync(LOCK) ? fs.readFileSync(LOCK, 'utf-8') : null;
      fs.rmSync(GUARD, { force: true });
    }, 200);
    await m.installModule('alpha', 'official-modules');
    expect(lockSeenByTimer).toBe(dead);
    expect(installedOnDisk().alpha).toBeDefined();
    expect(fs.existsSync(LOCK)).toBe(false);
    expect(fs.existsSync(GUARD)).toBe(false);
  }, 10_000);

  it('a lock taken by another process just before the guard is not deleted under the guard', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    write(LOCK, JSON.stringify({ pid: 2147483646, at: Date.now() }));
    const held = JSON.stringify({ pid: process.ppid, at: Date.now() });
    h.lockOnGuardOpen = held;
    let lockSeenByTimer: string | null | undefined;
    setTimeout(() => {
      lockSeenByTimer = fs.existsSync(LOCK) ? fs.readFileSync(LOCK, 'utf-8') : null;
      fs.rmSync(LOCK, { force: true });
    }, 200);
    await m.installModule('alpha', 'official-modules');
    expect(lockSeenByTimer).toBe(held);
    expect(installedOnDisk().alpha).toBeDefined();
  }, 10_000);

  it('a takeover guard left behind by a dead process is cleared', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    write(LOCK, JSON.stringify({ pid: 2147483646, at: Date.now() }));
    write(GUARD, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(GUARD, old, old);
    await m.installModule('alpha', 'official-modules');
    expect(installedOnDisk().alpha).toBeDefined();
    expect(fs.existsSync(GUARD)).toBe(false);
  }, 10_000);

  it('every git call under the lock has a timeout below the lock wait', async () => {
    const m = new AppStoreManager();
    await m.refreshRepository('official-modules');
    fs.rmSync(CLONE, { recursive: true, force: true });
    await m.refreshRepository('official-modules');
    const git = h.execs.filter(e => /^git (clone|fetch|remote|rev-parse)/.test(e.cmd));
    expect(new Set(git.map(e => e.cmd.split(' ')[1]))).toEqual(new Set(['clone', 'fetch', 'remote']));
    for (const e of git) {
      expect(typeof e.timeout).toBe('number');
      expect(e.timeout as number).toBeGreaterThan(0);
      expect(e.timeout as number).toBeLessThan(60_000);
    }
  });
});

describe('C16-1 an install records what it copied', () => {
  it('records the version in the copied module.json, not a stale scan', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    m.getCachedModules();
    publish('alpha', '2.0.0');
    setHead('c'.repeat(40));
    await m.installModule('alpha', 'official-modules');
    const copied = JSON.parse(fs.readFileSync(path.join(SOURCE, 'alpha', 'module.json'), 'utf-8'));
    expect(installedOnDisk().alpha.version).toBe(copied.version);
    expect(installedOnDisk().alpha.version).toBe('2.0.0');
    expect(installedOnDisk().alpha.commitHash).toBe('c'.repeat(40));
  });

  it('offers no update when only the commit moved and the files are the same', async () => {
    publish('alpha', '1.0.0');
    publish('beta', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    await m.installModule('beta', 'official-modules');
    publish('beta', '1.0.0', 'export const changed = 1;');
    setHead('d'.repeat(40));
    const result = await m.checkAllModulesForUpdates();
    const byName = Object.fromEntries(result.updates.map(u => [u.moduleName, u.hasUpdate]));
    expect(byName).toEqual({ alpha: false, beta: true });
    expect((await m.checkModuleForUpdate('alpha'))?.hasUpdate).toBe(false);
  });
});
