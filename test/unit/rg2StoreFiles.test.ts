import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rg2: the App Store's config files on a JSON bot through the real AppStoreManager: a repos.json
// that cannot be read, and addRepositoryAwaited's path on a bot whose docs are files.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const execSync = (cmd: string) => {
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
import { AppStoreManager, isSharedStoreDoc, storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';

const STORE = dataPath('global', 'appstore');
const REPOS = path.join(STORE, 'repos.json');
const BLOCKED = 'The repository list (repos.json) could not be read, so nothing was changed.';
let errors: string[];

beforeEach(() => {
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const asideLine = (cause: string) => `[AppStoreManager] repos.json could not be read (${cause}); App Store changes are blocked until it reads again`;

describe('a repos.json that cannot be read blocks App Store changes and lists no repository', () => {
  it('a read error other than a missing file: no repository, the cause logged as the error message, an add refused', () => {
    fs.mkdirSync(REPOS);
    let cause = '';
    try { fs.readFileSync(REPOS); } catch (error) { cause = (error as Error).message; }
    expect(cause).not.toBe('');
    const m = new AppStoreManager();
    expect(m.getRepositories()).toEqual([]);
    expect(errors).toContain(asideLine(cause));
    expect(() => m.addRepository('New', 'https://github.com/example/new', 'main')).toThrow(BLOCKED);
    expect(fs.statSync(REPOS).isDirectory()).toBe(true);
  });

  it('a read that throws a value with no message: the cause logged as that value, no repository', () => {
    fs.writeFileSync(REPOS, JSON.stringify({ repositories: [{ id: 'r1', name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === 'string' && path.resolve(p) === path.resolve(REPOS)) throw undefined;
      return (read as any)(p, ...rest);
    }) as typeof fs.readFileSync);
    const m = new AppStoreManager();
    expect(m.getRepositories()).toEqual([]);
    expect(errors).toContain(asideLine('undefined'));
    expect(() => m.addRepository('New', 'https://github.com/example/new', 'main')).toThrow(BLOCKED);
  });

  it('JSON whose shape is not a repository list: no repository, logged as an unexpected shape', () => {
    fs.writeFileSync(REPOS, JSON.stringify({ repositories: [{ name: 'no id' }] }));
    const m = new AppStoreManager();
    expect(m.getRepositories()).toEqual([]);
    expect(errors).toContain(asideLine('unexpected shape'));
    expect(() => m.addRepository('New', 'https://github.com/example/new', 'main')).toThrow(BLOCKED);
  });

  it('bytes that are not JSON: no repository, the parse error message logged', () => {
    const text = '{"repositories": [';
    fs.writeFileSync(REPOS, text);
    let cause = '';
    try { JSON.parse(text); } catch (error) { cause = (error as Error).message; }
    expect(cause).not.toBe('');
    const m = new AppStoreManager();
    expect(m.getRepositories()).toEqual([]);
    expect(errors).toContain(asideLine(cause));
  });

  it('a parse that throws a value with no message: the cause logged as that value, no repository', () => {
    const marker = 'rg2-parse-throws-nothing';
    fs.writeFileSync(REPOS, JSON.stringify({ repositories: [{ id: marker, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }));
    const parse = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: any) => {
      if (typeof text === 'string' && text.includes(marker)) throw undefined;
      return parse(text, reviver);
    }) as typeof JSON.parse);
    const m = new AppStoreManager();
    expect(m.getRepositories()).toEqual([]);
    expect(errors).toContain(asideLine('undefined'));
  });
});

describe('addRepositoryAwaited on a bot whose App Store docs are files', () => {
  it('writes repos.json before it returns, without waiting for the store mutex a Postgres section holds', async () => {
    expect(isSharedStoreDoc(REPOS)).toBe(false);
    const m = new AppStoreManager();
    const hold = await storeMutex.acquire(1_000);
    expect(hold).not.toBeNull();
    let pending: Promise<unknown> | null = null;
    try {
      pending = m.addRepositoryAwaited('New', 'https://github.com/example/new', 'dev');
      const onDisk = JSON.parse(fs.readFileSync(REPOS, 'utf8'));
      expect(onDisk.repositories.map((r: { name: string; branch: string }) => `${r.name}:${r.branch}`)).toContain('New:dev');
    } finally {
      hold!.release();
    }
    const repo = await pending;
    expect(repo).toMatchObject({ name: 'New', url: 'https://github.com/example/new', branch: 'dev', enabled: true });
  });
});
