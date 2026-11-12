import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dirs: { source: '', build: '', dist: '', dev: '' },
  afterLand: null as null | ((key: string) => void),
}));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const execSync = (cmd: string) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => undefined }));

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

vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    landStoreDoc: (key: string, body: Buffer | null, sha: string, main: string | null) => {
      real.landStoreDoc(key, body, sha, main);
      h.afterLand?.(key);
    },
  };
});

import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { applyRig } from '../helpers/nb6ApplyRig';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const INSTALLED_FILE = path.join(STORE, 'installed.json');
const INSTALLED_KEY = 'global/appstore/installed.json';
const UNREADABLE = path.join(STORE, 'cache', 'unreadable');
const CREDS_FILE = path.join(STORE, 'credentials', 'm.json');
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const LONG = `${'q'.repeat(210)}.js`;
const LONG_CAUSE = `the part "${'q'.repeat(40)}..." is 213 bytes; one part of a key holds at most 200`;

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  h.afterLand = null;
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, 'repos.json'), JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
});

afterEach(async () => {
  h.afterLand = null;
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  setStoppedServingHook(null);
  useWebuiSessions(null);
  await rig.teardown();
});

const cloneDir = () => path.join(STORE, 'cache', REPO, 'Modules', 'm');

function clone(files: Record<string, string>, dirs: string[] = []): void {
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const sub of dirs) fs.mkdirSync(path.join(cloneDir(), sub), { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(cloneDir(), ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

const errorLines = () => (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(call => String(call[0]));

describe("an uninstall's landing of the credentials removal", () => {
  it('with no credentials mirror on disk, deletes no credentials file', async () => {
    clone(V1);
    const m = new AppStoreManager();
    await m.installModule('m', REPO);
    expect(fs.existsSync(CREDS_FILE)).toBe(false);
    const unlinks: string[] = [];
    const realUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file: fs.PathLike) => {
      unlinks.push(path.resolve(String(file)));
      realUnlink(file);
    });
    // sharedStore reads fs through a namespace import, which sees the spy only once the builtin exports are synced.
    syncBuiltinESMExports();
    await m.uninstallModule('m');
    expect(rig.state.rows.modules.has('m')).toBe(false);
    expect(unlinks).not.toContain(path.resolve(CREDS_FILE));
  });
});

describe("the landing re-reads installed.json under the store lock", () => {
  it('an installed.json overwritten with bytes that do not read is set aside during the install, with its log line', async () => {
    clone(V1);
    const m = new AppStoreManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.afterLand = key => {
      if (key === INSTALLED_KEY) fs.writeFileSync(INSTALLED_FILE, 'not json');
    };
    await m.installModule('m', REPO);
    h.afterLand = null;
    const lines = errorLines();
    expect(lines.some(line => line.startsWith('[AppStoreManager] installed.json could not be read ('))).toBe(true);
    const copies = fs.existsSync(UNREADABLE) ? fs.readdirSync(UNREADABLE).filter(n => n.startsWith('installed.json.')) : [];
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(UNREADABLE, copies[0]), 'utf8')).toBe('not json');
  });
});

describe('a path refusal among entries the folder lists under one name', () => {
  it('names the entry the listing gives first', async () => {
    clone({ ...V1, [`${LONG}/f.js`]: '1' });
    const realReaddir = fs.readdirSync.bind(fs) as (...args: unknown[]) => unknown;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((at: fs.PathLike, options?: unknown) => {
      const listed = realReaddir(at, options);
      if (path.resolve(String(at)) !== path.resolve(cloneDir()) || !(options as { withFileTypes?: boolean } | undefined)?.withFileTypes) return listed;
      const entries = listed as fs.Dirent[];
      const dir = entries.find(e => e.name === LONG)!;
      const asFile = Object.assign(Object.create(Object.getPrototypeOf(dir)), dir, { isDirectory: () => false, isFile: () => true });
      return [...entries.filter(e => e !== dir), dir, asFile];
    }) as typeof fs.readdirSync);
    const m = new AppStoreManager();
    await expect(m.installModule('m', REPO)).rejects.toThrow(
      `m was not installed: its file ${LONG}/f.js cannot be stored for every machine (${LONG_CAUSE}), so nothing was changed.`,
    );
    expect(rig.state.rows.modules.has('m')).toBe(false);
  });
});
