import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// updateModule on a Postgres bot (NB6 decision 35) through the real AppStoreManager, the real publish over scripted
// clients (helpers/sharedRows.ts) and the real apply with the fake loader (helpers/nb6FakeLoader.ts), as rg5 drives it.

const h = vi.hoisted(() => ({ dirs: { source: '', build: '', dist: '', dev: '' } }));

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

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { applyRig, moduleShaOfFiles } from '../helpers/nb6ApplyRig';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const INSTALLED = 'global/appstore/installed.json';
const INSTALLED_FILE = path.join(STORE, 'installed.json');
const REPOS_FILE = path.join(STORE, 'repos.json');
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const V2 = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(REPOS_FILE, JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
});

afterEach(async () => {
  setStoppedServingHook(null);
  useWebuiSessions(null);
  await rig.teardown();
  vi.restoreAllMocks();
});

function clone(modules: Record<string, Record<string, string>>): void {
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [name, files] of Object.entries(modules)) {
    for (const [rel, text] of Object.entries(files)) {
      const file = path.join(dir, 'Modules', name, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  }
}

async function installed(): Promise<{ m: AppStoreManager; sha: string }> {
  clone({ m: V1 });
  const m = new AppStoreManager();
  await m.installModule('m', REPO);
  return { m, sha: moduleShaOfFiles(V1) };
}

describe('the checks at the start of an update read repos.json as it is now', () => {
  it('the repository was removed and the module folder is gone: repository not found, nothing published', async () => {
    const { m, sha } = await installed();
    fs.writeFileSync(REPOS_FILE, JSON.stringify({ repositories: [] }, null, 2));
    fs.rmSync(path.join(rig.state.source, 'm'), { recursive: true, force: true });
    clone({ m: V2 });
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: `Repository ${REPO} not found` });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
  });
});

describe('installed.json that no read can open', () => {
  it('is refused as unreadable when the path is a folder, and nothing is published', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { m, sha } = await installed();
    fs.rmSync(INSTALLED_FILE, { force: true });
    fs.mkdirSync(INSTALLED_FILE, { recursive: true });
    clone({ m: V2 });
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: 'The installed modules list (installed.json) could not be read, so nothing was changed.' });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
  });
});

describe('a refusal because installed.json changed elsewhere', () => {
  it('names the module as removed when the stored installed.json is the JSON null', async () => {
    const { m } = await installed();
    clone({ m: V2 });
    rig.state.rows.put(INSTALLED, 'null');
    const seen: Array<string | undefined> = [];
    rig.state.rows.fault = (sql, params) => {
      if (sql === 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1' && params?.[0] === INSTALLED) {
        seen.push(rig.state.rows.docs.get(INSTALLED)?.body.toString('utf8'));
      }
      return undefined;
    };
    const result = await m.updateModule('m');
    expect(result).toMatchObject({ success: false, changedElsewhere: true, elsewhere: { kind: 'removed', by: 'BRAVO' } });
    expect(seen).toContain('null');
  });
});
