import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rg2: an install and an uninstall on a Postgres bot through the real AppStoreManager over the
// apply rig (helpers/nb6ApplyRig.ts). A test may script the publish's answer or the apply's failure.

const h = vi.hoisted(() => ({
  dirs: { source: '', build: '', dist: '', dev: '' },
  publish: null as unknown,
  applyFails: null as Error | null,
  later: null as unknown,
}));

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

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

vi.mock('../../src/bot/internalSetup/utils/sharedModules', async orig => {
  const real = await orig<any>();
  return { ...real, publishModule: (...args: unknown[]) => (h.publish ? Promise.resolve(h.publish) : real.publishModule(...args)) };
});

vi.mock('../../src/bot/internalSetup/utils/moduleApply', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    applyModuleChange: (...args: unknown[]) => (h.applyFails ? Promise.reject(h.applyFails) : real.applyModuleChange(...args)),
    applyLaterOf: (module: string) => h.later ?? real.applyLaterOf(module),
  };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager, StoreWriteError, stagedHeld, type PublishedChange } from '../../src/bot/internalSetup/utils/appStoreManager';
import { moduleRelRefusal } from '../../src/bot/internalSetup/utils/sharedModules';
import { applyRig, moduleShaOfFiles } from '../helpers/nb6ApplyRig';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const INSTALLED = 'global/appstore/installed.json';
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n', 'sub/deep/x.js': 'exports.x = 1;\n' };

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  h.publish = null;
  h.applyFails = null;
  h.later = null;
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, 'repos.json'), JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
});

afterEach(async () => {
  h.publish = null;
  h.applyFails = null;
  h.later = null;
  await rig.teardown();
});

function clone(files: Record<string, string>): void {
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(dir, 'Modules', 'm', ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

const staged = () => fs.readdirSync(rig.state.source).filter(n => n.startsWith('.incoming-'));

/** The path below the staged folder, or null for a path outside one. */
function stagedRel(p: string): string | null {
  const parts = path.resolve(p).split(path.sep);
  const at = parts.findIndex(part => part.startsWith('.incoming-m-'));
  return at < 0 ? null : parts.slice(at + 1).join('/');
}

describe('decision 35 step 2: every staged file is on disk before the publish stores it', () => {
  it('each staged file, nested folders included, was fsynced before the COMMIT', async () => {
    clone(V1);
    const m = new AppStoreManager();
    const opened = new Map<number, string>();
    const synced = new Set<string>();
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const fd = (open as any)(p, ...rest);
      opened.set(fd, String(p));
      return fd;
    }) as typeof fs.openSync);
    const fsync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      const rel = opened.has(fd) ? stagedRel(opened.get(fd)!) : null;
      if (rel && fs.fstatSync(fd).isFile()) synced.add(rel);
      return (fsync as any)(fd);
    }) as typeof fs.fsyncSync);
    let atCommit: string[] | null = null;
    rig.state.rows.fault = sql => {
      if (sql === 'COMMIT' && atCommit === null) atCommit = [...synced].sort();
      return undefined;
    };
    const answer = await m.installModule('m', REPO) as PublishedChange;
    expect(answer).toMatchObject({ module: 'm', operation: 'install', version: '1.0.0', to: moduleShaOfFiles(V1) });
    expect(atCommit).toEqual(['index.js', 'module.json', 'sub/deep/x.js']);
    expect(rig.live('m')).toEqual(V1);
  });
});

describe('the staged folders this process holds', () => {
  it('the staged folder is held while the publish runs and let go once the install is applied', async () => {
    clone(V1);
    const m = new AppStoreManager();
    let heldAtCommit: string[] | null = null;
    rig.state.rows.fault = sql => {
      if (sql === 'COMMIT' && heldAtCommit === null) heldAtCommit = [...stagedHeld()];
      return undefined;
    };
    await m.installModule('m', REPO);
    expect(heldAtCommit).toHaveLength(1);
    expect(path.basename(heldAtCommit![0])).toMatch(/^\.incoming-m-/);
    expect([...stagedHeld()]).toEqual([]);
    expect(staged()).toEqual([]);
  });
});

describe("a publish refuses a file path the migration's rule refuses, after a folder whose files pass", () => {
  it('the refused file after a clean folder names the refusal and stores nothing', async () => {
    const LONG = `b${'a'.repeat(209)}.js`;
    clone({ ...V1, 'a/ok.js': 'exports.ok = 1;\n', [LONG]: 'exports.y = 1;\n' });
    const m = new AppStoreManager();
    const cause = moduleRelRefusal(LONG);
    expect(cause).not.toBeNull();
    const error = await m.installModule('m', REPO).then(() => null, e => e);
    expect(error?.message).toBe(`m was not installed: its file ${LONG} cannot be stored for every machine (${cause}), so nothing was changed.`);
    expect(rig.state.rows.modules.has('m')).toBe(false);
    expect(rig.state.rows.docs.has(INSTALLED)).toBe(false);
    expect(staged()).toEqual([]);
  });
});

describe("decision 42's texts for a publish that stored nothing", () => {
  it('writer-lost: 500 naming the module and the process that took over', async () => {
    clone(V1);
    const m = new AppStoreManager();
    h.publish = { kind: 'refused', cause: 'writer-lost' };
    const error = await m.installModule('m', REPO).then(() => null, e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(500);
    expect(error.message).toBe("m was not installed: another process took over the bot's data files");
    expect(staged()).toEqual([]);
    expect(rig.live('m')).toBeNull();
  });

  it('changed-elsewhere with a time but no machine: the deleted text, not saved', async () => {
    clone(V1);
    const m = new AppStoreManager();
    h.publish = { kind: 'refused', cause: 'changed-elsewhere', at: new Date('2026-11-12T10:00:00.000Z') };
    const error = await m.installModule('m', REPO).then(() => null, e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(409);
    expect(error.message).toBe('This data was deleted after your change read it, so your change was not saved. Reload to see the current values, then try again.');
    expect(error.by).toBeUndefined();
    expect(staged()).toEqual([]);
  });
});

describe('E1: an uninstall stored, whose removal here threw', () => {
  it("names the bot's next start when the apply waits for it", async () => {
    clone(V1);
    const m = new AppStoreManager();
    await m.installModule('m', REPO);
    expect(rig.live('m')).toEqual(V1);
    h.applyFails = new Error('injected removal failure');
    h.later = { kind: 'start' };
    const change = await m.uninstallModule('m') as PublishedChange;
    expect(change).toMatchObject({ module: 'm', operation: 'uninstall', to: 'absent' });
    expect(change.applied?.text).toBe("m is uninstalled for every machine, but this machine could not remove it yet (injected removal failure); it removes it after the bot's next start.");
    expect(rig.state.rows.modules.has('m')).toBe(false);
  });
});
