import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rg5: updateModule on a Postgres bot (NB6 decision 35) through the real AppStoreManager, the real
// publish over scripted clients (helpers/sharedRows.ts) and the real apply with the fake loader (helpers/nb6FakeLoader.ts).

const h = vi.hoisted(() => ({ dirs: { source: '', build: '', dist: '', dev: '' }, snapshots: [] as string[] }));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const execSync = (cmd: string) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: (label: string) => { h.snapshots.push(label); } }));

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
import { AppStoreManager, storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { applyRig, moduleShaOfFiles } from '../helpers/nb6ApplyRig';
import { pgError } from '../helpers/sharedRows';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const INSTALLED = 'global/appstore/installed.json';
const INSTALLED_FILE = path.join(STORE, 'installed.json');
const REPOS_FILE = path.join(STORE, 'repos.json');
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const V2 = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const OLD = (name: string) => ({ 'module.json': `{"name":"${name}","version":"0.1.0"}`, 'index.js': 'exports.v = 0;\n' });

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  h.snapshots = [];
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(REPOS_FILE, JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
});

afterEach(async () => {
  setStoppedServingHook(null);
  useWebuiSessions(null);
  await rig.teardown();
});

/** The repository clone in the store's cache holds these modules. */
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
  h.snapshots = [];
  return { m, sha: moduleShaOfFiles(V1) };
}

describe('the checks at the start of an update read the files as they are now', () => {
  it('installed.json no longer lists the module: not installed, nothing published', async () => {
    const { m, sha } = await installed();
    fs.writeFileSync(INSTALLED_FILE, JSON.stringify({ modules: {} }, null, 2));
    clone({ m: V2 });
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: 'Module m is not installed' });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
    expect(h.snapshots).toEqual([]);
  });

  it('installed.json cannot be read: refused with the read text, nothing published', async () => {
    const { m, sha } = await installed();
    fs.writeFileSync(INSTALLED_FILE, '{ not json');
    clone({ m: V2 });
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: 'The installed modules list (installed.json) could not be read, so nothing was changed.' });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
  });

  it('the repository was removed from repos.json: not found, nothing published', async () => {
    const { m, sha } = await installed();
    fs.writeFileSync(REPOS_FILE, JSON.stringify({ repositories: [] }, null, 2));
    clone({ m: V2 });
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: `Repository ${REPO} not found` });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
  });

  it('the module folder is gone: not updated, with the reinstall text', async () => {
    const { m, sha } = await installed();
    fs.rmSync(path.join(rig.state.source, 'm'), { recursive: true, force: true });
    clone({ m: V2 });
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: 'Module m has no files where it was installed, so it was not updated. Reinstall it from the App Store.' });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
    expect(h.snapshots).toEqual([]);
  });

  it('the repository no longer has the module: not updated', async () => {
    const { m, sha } = await installed();
    clone({ a: OLD('a') });
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: 'Module m no longer exists in repository' });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
  });
});

describe('the version the repository offers', () => {
  it('the same version: answers success with that version, takes no snapshot and publishes nothing', async () => {
    const { m, sha } = await installed();
    const sent = rig.state.pg.sent.length;
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: true, newVersion: '1.0.0' });
    expect(h.snapshots).toEqual([]);
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
    expect(rig.state.pg.sent.slice(sent).some(s => s.sql.includes('shared_module'))).toBe(false);
  });

  it('a newer version of the module among other modules: that module is updated, after a snapshot named for it', async () => {
    const { m } = await installed();
    clone({ a: OLD('a'), m: V2, z: OLD('z') });
    const result = await m.updateModule('m');
    expect(result).toMatchObject({ success: true, newVersion: '2.0.0' });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V2));
    expect(rig.live('m')).toEqual(V2);
    expect(h.snapshots).toEqual(['update m']);
  });
});

describe('answers when the update cannot run or is refused', () => {
  it('another App Store change holds the store mutex past its bound: not updated, with the busy text', async () => {
    const { m, sha } = await installed();
    clone({ m: V2 });
    const hold = (await storeMutex.acquire())!;
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const answer = m.updateModule('m');
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await answer;
      vi.useRealTimers();
      expect(result).toEqual({ success: false, error: 'Another App Store change is still running, so nothing was changed. Try again in a minute.' });
    } finally {
      vi.useRealTimers();
      hold.release();
    }
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
  });

  it('a database error before COMMIT: not updated, with the cause, and not marked as changed elsewhere', async () => {
    const { m, sha } = await installed();
    clone({ m: V2 });
    rig.state.rows.fault = sql => (sql.startsWith('DELETE FROM smdb_data.shared_module_files') ? pgError('53100', 'could not extend file: No space left on device') : undefined);
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: expect.stringMatching(/^m was not updated: .*No space left on device/) });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(sha);
  });

  it('installed.json changed elsewhere with the same version but the module row holds other files: the module changed', async () => {
    const { m } = await installed();
    clone({ m: V2 });
    const row = rig.state.rows.modules.get('m')!;
    row.sha = 'f'.repeat(64);
    rig.state.rows.put(INSTALLED, JSON.stringify({ modules: { m: { name: 'm', version: '1.0.0', installedFrom: REPO, note: 'other' } } }));
    const result = await m.updateModule('m');
    expect(result).toMatchObject({ success: false, changedElsewhere: true, elsewhere: { kind: 'module', by: 'BRAVO' } });
  });
});
