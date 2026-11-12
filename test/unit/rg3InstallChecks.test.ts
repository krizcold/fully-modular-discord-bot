import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// An App Store install's checks on a JSON bot: which repository and which module it takes, when it refreshes the
// clone, what it says when the module is missing, and when it refuses a module that is already there.

const h = vi.hoisted(() => ({
  clone: null as null | ((dir: string) => void),
  cloneFails: false,
  commands: [] as string[],
}));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const fsReal = await vi.importActual<any>('fs');
  const pathReal = await vi.importActual<any>('path');
  const execSync = (cmd: string) => {
    h.commands.push(cmd.split(' ').slice(0, 2).join(' '));
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    if (cmd.startsWith('git clone')) {
      if (h.cloneFails) throw new Error('fatal: could not read from remote repository');
      const target = cmd.match(/"([^"]+)"$/)![1];
      fsReal.mkdirSync(pathReal.join(target, '.git'), { recursive: true });
      h.clone?.(target);
      return Buffer.from('');
    }
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => undefined }));

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
import { setBackendKind } from '../helpers/backendKind';

const STORE = dataPath('global', 'appstore');
const CACHE = path.join(STORE, 'cache');
const CLONE = path.join(CACHE, 'official-modules');
const REPOS = path.join(STORE, 'repos.json');
const INSTALLED = path.join(STORE, 'installed.json');
const SOURCE = dataPath('appstore-modules');
const BUILD = dataPath('build-modules');
const RUNTIME = dataPath('runtime-modules');
const VERSIONS: Record<string, string> = { alpha: '1.0.0', beta: '3.0.0' };

let logs: string[];
let errorCalls: unknown[][];

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function putModules(dir: string, versions: Record<string, string>): void {
  for (const [name, version] of Object.entries(versions)) {
    write(path.join(dir, 'Modules', name, 'module.json'), JSON.stringify({ name, version }));
    write(path.join(dir, 'Modules', name, 'index.ts'), 'export {};');
  }
}

function reset(): void {
  for (const dir of [STORE, SOURCE, BUILD, RUNTIME, dataPath('modulesDev')]) fs.rmSync(dir, { recursive: true, force: true });
  h.clone = null;
  h.cloneFails = false;
  h.commands = [];
  logs = [];
  errorCalls = [];
}

const installedEntry = (name: string) => JSON.parse(fs.readFileSync(INSTALLED, 'utf8')).modules[name];
const copiedManifest = (name: string) => JSON.parse(fs.readFileSync(path.join(SOURCE, name, 'module.json'), 'utf8'));
const officialRepo = () => JSON.parse(fs.readFileSync(REPOS, 'utf8')).repositories.find((r: { id: string }) => r.id === 'official-modules');

beforeEach(() => {
  setBackendKind('file');
  reset();
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errorCalls.push(args); });
});

afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('a module the clone already holds', () => {
  it('installs from the clone without fetching it again', async () => {
    putModules(CLONE, { alpha: '1.0.0' });
    fs.mkdirSync(path.join(CLONE, '.git'), { recursive: true });
    const m = new AppStoreManager();
    await expect(m.installModule('alpha', 'official-modules')).resolves.toBe(true);
    expect(installedEntry('alpha').version).toBe('1.0.0');
    expect(copiedManifest('alpha').name).toBe('alpha');
    expect(h.commands.filter(c => c === 'git clone' || c === 'git fetch' || c === 'git remote')).toEqual([]);
    expect(officialRepo().lastRefreshed).toBeNull();
    expect(logs.some(line => line.includes('not in cache'))).toBe(false);
  });

  it('installs the named module when the clone holds several', async () => {
    for (const name of Object.keys(VERSIONS)) {
      reset();
      putModules(CLONE, VERSIONS);
      fs.mkdirSync(path.join(CLONE, '.git'), { recursive: true });
      const m = new AppStoreManager();
      await expect(m.installModule(name, 'official-modules')).resolves.toBe(true);
      expect(installedEntry(name).version).toBe(VERSIONS[name]);
      expect(copiedManifest(name)).toEqual({ name, version: VERSIONS[name] });
    }
  });

  it('lists the clone as rescanned by the install, with a module added since the last refresh', async () => {
    putModules(CLONE, { alpha: '1.0.0' });
    fs.mkdirSync(path.join(CLONE, '.git'), { recursive: true });
    const m = new AppStoreManager();
    expect((await m.getAvailableModules()).map(i => i.manifest.name)).toEqual(['alpha']);
    putModules(CLONE, { alpha: '2.0.0', beta: '3.0.0' });
    h.commands = [];
    await expect(m.installModule('beta', 'official-modules')).resolves.toBe(true);
    const listed = await m.getAvailableModules();
    expect(h.commands.filter(c => c === 'git fetch' || c === 'git clone')).toEqual([]);
    expect(Object.fromEntries(listed.map(i => [i.manifest.name, i.manifest.version]))).toEqual({ alpha: '2.0.0', beta: '3.0.0' });
    expect(listed.find(i => i.manifest.name === 'beta')?.installed).toBe(true);
  });
});

describe('a module the clone does not hold yet', () => {
  it('refreshes the repository, says so in the log, and installs the named module', async () => {
    for (const name of Object.keys(VERSIONS)) {
      reset();
      h.clone = dir => putModules(dir, VERSIONS);
      const m = new AppStoreManager();
      await expect(m.installModule(name, 'official-modules')).resolves.toBe(true);
      expect(logs).toContain(`[AppStoreManager] Module ${name} not in cache, refreshing repository...`);
      expect(h.commands).toContain('git clone');
      expect(installedEntry(name).version).toBe(VERSIONS[name]);
      expect(copiedManifest(name)).toEqual({ name, version: VERSIONS[name] });
    }
  });

  it('installs a single module the refresh brings', async () => {
    h.clone = dir => putModules(dir, { alpha: '1.0.0' });
    const m = new AppStoreManager();
    await expect(m.installModule('alpha', 'official-modules')).resolves.toBe(true);
    expect(installedEntry('alpha').version).toBe('1.0.0');
  });

  it('a leftover folder without .git is not taken as the clone: the fresh clone\'s version is installed', async () => {
    putModules(CLONE, { alpha: '1.0.0' });
    h.clone = dir => putModules(dir, { alpha: '2.0.0' });
    const m = new AppStoreManager();
    await expect(m.installModule('alpha', 'official-modules')).resolves.toBe(true);
    expect(h.commands).toContain('git clone');
    expect(installedEntry('alpha').version).toBe('2.0.0');
    expect(copiedManifest('alpha').version).toBe('2.0.0');
  });

  it('a failed refresh is logged with its error, and the reply names the module and the repository', async () => {
    h.cloneFails = true;
    const m = new AppStoreManager();
    const error = await m.installModule('alpha', 'official-modules').catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Module alpha not found in repository Official Module Store');
    const logged = errorCalls.find(args => args[0] === '[AppStoreManager] Failed to refresh repository:');
    expect(logged).toBeDefined();
    expect(String((logged![1] as Error).message)).toMatch(/could not read from remote repository/);
    expect(fs.existsSync(path.join(SOURCE, 'alpha'))).toBe(false);
  });
});

describe('the repository', () => {
  it('an unknown repository id is named in the reply', async () => {
    const m = new AppStoreManager();
    await expect(m.installModule('alpha', 'no-such-repo')).rejects.toThrow(/^Repository no-such-repo not found$/);
  });

  it('a repository another process added since this one read the list is found', async () => {
    const m1 = new AppStoreManager();
    const m2 = new AppStoreManager();
    const repo = m2.addRepository('Extra', 'https://github.com/someone/extra-modules');
    h.clone = dir => putModules(dir, { alpha: '1.0.0' });
    await expect(m1.installModule('alpha', repo.id)).resolves.toBe(true);
    expect(installedEntry('alpha')).toMatchObject({ version: '1.0.0', installedFrom: repo.id });
  });
});

describe('a module that is already there', () => {
  it('a module folder not in the installed list is refused and left as it was', async () => {
    putModules(CLONE, { alpha: '1.0.0' });
    fs.mkdirSync(path.join(CLONE, '.git'), { recursive: true });
    const m = new AppStoreManager();
    write(path.join(SOURCE, 'alpha', 'keep.txt'), 'operator file');
    await expect(m.installModule('alpha', 'official-modules')).rejects.toThrow('Module alpha is already installed');
    expect(fs.readdirSync(path.join(SOURCE, 'alpha'))).toEqual(['keep.txt']);
    expect(fs.existsSync(INSTALLED) ? installedEntry('alpha') : undefined).toBeUndefined();
  });

  it('a second install of an installed module is refused', async () => {
    putModules(CLONE, { alpha: '1.0.0' });
    fs.mkdirSync(path.join(CLONE, '.git'), { recursive: true });
    const m = new AppStoreManager();
    await expect(m.installModule('alpha', 'official-modules')).resolves.toBe(true);
    const before = fs.readFileSync(INSTALLED, 'utf8');
    putModules(CLONE, { alpha: '9.0.0' });
    await expect(m.installModule('alpha', 'official-modules')).rejects.toThrow('Module alpha is already installed');
    expect(fs.readFileSync(INSTALLED, 'utf8')).toBe(before);
    expect(copiedManifest('alpha').version).toBe('1.0.0');
  });
});
