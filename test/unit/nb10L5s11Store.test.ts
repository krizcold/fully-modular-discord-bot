import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The App Store lock's cache folder, and an installed.json that turns unreadable during an update.

const h = vi.hoisted(() => ({ failInstalledRenames: 0, garbage: '{"modules": not json' }));

vi.mock('fs', async orig => {
  const real = await orig<any>();
  const wrapped = {
    ...real,
    renameSync: (from: any, to: any) => {
      if (h.failInstalledRenames > 0 && path.basename(String(to)) === 'installed.json') {
        h.failInstalledRenames--;
        real.writeFileSync(to, h.garbage);
        throw Object.assign(new Error(`EIO: i/o error, rename '${from}'`), { code: 'EIO' });
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
    if (cmd.startsWith('git rev-parse HEAD')) {
      return Buffer.from(fsReal.readFileSync(path.join(opts.cwd, '.git', 'HEAD_HASH'), 'utf-8'));
    }
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
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
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';

const STORE = dataPath('global', 'appstore');
const CACHE = path.join(STORE, 'cache');
const INSTALLED = path.join(STORE, 'installed.json');
const REPOS = path.join(STORE, 'repos.json');
const CLONE = path.join(CACHE, 'official-modules');
const SOURCE = dataPath('appstore-modules');
const BUILD = dataPath('build-modules');

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function publish(name: string, version: string): void {
  write(path.join(CLONE, 'Modules', name, 'module.json'), JSON.stringify({ name, version }));
  write(path.join(CLONE, 'Modules', name, 'index.ts'), 'export {};');
  write(path.join(CLONE, '.git', 'HEAD_HASH'), 'a'.repeat(40));
}

beforeEach(() => {
  for (const dir of [STORE, SOURCE, BUILD, dataPath('runtime-modules')]) fs.rmSync(dir, { recursive: true, force: true });
  h.failInstalledRenames = 0;
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the store lock and its cache folder', () => {
  it('a change made after the cache folder was removed recreates it and saves', () => {
    const m = new AppStoreManager();
    fs.rmSync(CACHE, { recursive: true, force: true });
    const repo = m.addRepository('Extra', 'https://github.com/someone/extra-modules');
    const saved = JSON.parse(fs.readFileSync(REPOS, 'utf-8')).repositories.map((r: any) => r.id);
    expect(saved).toContain(repo.id);
    expect(fs.existsSync(path.join(CACHE, '.store.lock'))).toBe(false);
  });
});

describe('installed.json turns unreadable while an update saves it', () => {
  it('the rollback never overwrites the unreadable file, and the reply says the old version could not be restored', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    expect(JSON.parse(fs.readFileSync(INSTALLED, 'utf-8')).modules.alpha.version).toBe('1.0.0');
    publish('alpha', '2.0.0');
    h.failInstalledRenames = 4;
    const result = await m.updateModule('alpha');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/could not be restored/);
    expect(fs.readFileSync(INSTALLED, 'utf-8')).toBe(h.garbage);
  });
});
