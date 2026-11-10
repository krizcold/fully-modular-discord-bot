import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 row 39 (T13): a config save, a restore and a data file save whose backup is renamed into place but whose
// folder chain failed stop before the target's write; the backup is on disk and the reply says it can't be confirmed.

const h = vi.hoisted(() => ({
  fail: new Map<string, { kind: 'sync' | 'open' | 'earlier'; errno: string }>(),
  first: null as null | { dir: string; errno: string },
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChainSync: (dir: string) => {
      const at = path.resolve(dir);
      if (h.first && real.folderSyncFailed()) return { failed: true, kind: 'earlier', dir: h.first.dir, errno: h.first.errno, error: null };
      const f = h.fail.get(at);
      if (!f) return real.syncFolderChainSync(dir);
      if (f.kind === 'sync') {
        real.noteFolderSyncFailure(at, f.errno);
        h.first ??= { dir: at, errno: f.errno };
      }
      return { failed: true, kind: f.kind, dir: at, errno: f.errno, error: null };
    },
  };
});

import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { writeBackup } from '../../src/webui/utils/configBackups';
import { dataPath } from '../../src/utils/dataRoot';
import { BACKUPS, FakeChild, backupNames, call, put, resetData, startConfigApp } from '../helpers/configRig';

const G = '191900000000000039';
const child = new FakeChild();
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  ({ url: base, close } = await startConfigApp(child));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  h.fail.clear();
  h.first = null;
  child.reset();
  await resetData();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const T1 = (file: string, kind: 'sync' | 'earlier' = 'sync') => {
  const { why, next } = syncWords(kind, path.resolve(BACKUPS()), 'EIO');
  return `${file} is written, but ${why}, so can't confirm it is stored. ${next}`;
};

/** The one backup this test's failed chain left, read from the disk, and its T1. */
function newBackup(before: string[]): { file: string; body: string } {
  const added = backupNames().filter(n => !before.includes(n));
  expect(added).toHaveLength(1);
  const file = path.join(BACKUPS(), added[0]);
  return { file, body: fs.readFileSync(file, 'utf8') };
}

const noTargetWrite = () => {
  expect(child.writes).toEqual([]);
  expect(child.sharedOps.filter(o => o.op === 'global.write')).toEqual([]);
};

describe('row 39: the backup\'s folder chain fails', () => {
  it('a config save: 500 with T13, the backup holds the current body, the target is not written', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const served = fs.readFileSync(ROOT_CONFIG_PATH, 'utf8');
    const before = backupNames();
    h.fail.set(path.resolve(BACKUPS()), { kind: 'sync', errno: 'EIO' });
    const reply = await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 } });
    const backup = newBackup(before);
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({
      success: false,
      error: `Failed to update config: nothing was saved, because the backup of config.json can't be confirmed as saved: ${T1(backup.file)}`,
    });
    expect(backup.body).toBe(served);
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe(served);
    noTargetWrite();
  });

  it('a restore: 500 with T13, the before-restore backup holds the current body, the target is not written', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const served = fs.readFileSync(ROOT_CONFIG_PATH, 'utf8');
    const older = writeBackup(BACKUPS(), 'config.json', null, JSON.stringify({ a: 0 }, null, 2)).filename;
    const before = backupNames();
    h.fail.set(path.resolve(BACKUPS()), { kind: 'sync', errno: 'EIO' });
    const reply = await call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: older });
    const backup = newBackup(before);
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({
      success: false,
      error: `Nothing was restored, because the backup of the current version can't be confirmed as saved: ${T1(backup.file)}`,
    });
    expect(backup.body).toBe(served);
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe(served);
    noTargetWrite();
  });

  it('a data file save: 500 with T13, the backup holds the current body, the target is not written', async () => {
    const target = dataPath(G, 'mod', 'x.json');
    put(target, { d: 1 });
    const served = fs.readFileSync(target, 'utf8');
    const before = backupNames();
    const loaded = await call(base, 'GET', `/api/config/data/get?file=${encodeURIComponent('mod/x.json')}&guildId=${G}`);
    expect(loaded.status).toBe(200);
    h.fail.set(path.resolve(BACKUPS()), { kind: 'sync', errno: 'EIO' });
    const reply = await call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { d: 2 }, guildId: G, loadedSha: loaded.body.sha });
    const backup = newBackup(before);
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({
      success: false,
      error: `Failed to save data file: nothing was saved, because the backup of mod/x.json can't be confirmed as saved: ${T1(backup.file)}`,
    });
    expect(backup.body).toBe(served);
    expect(fs.readFileSync(target, 'utf8')).toBe(served);
    noTargetWrite();
  });

  it('a second config save after the EIO: its backup is on disk, T13 quotes the EIO as earlier, the target is not written', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const served = fs.readFileSync(ROOT_CONFIG_PATH, 'utf8');
    h.fail.set(path.resolve(BACKUPS()), { kind: 'sync', errno: 'EIO' });
    expect((await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 } })).status).toBe(500);
    h.fail.clear();
    const before = backupNames();
    const reply = await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 3 } });
    const backup = newBackup(before);
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({
      success: false,
      error: `Failed to update config: nothing was saved, because the backup of config.json can't be confirmed as saved: ${T1(backup.file, 'earlier')}`,
    });
    expect(backup.body).toBe(served);
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe(served);
    noTargetWrite();
  });

  it('a backup whose rename fails keeps today\'s text', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const served = fs.readFileSync(ROOT_CONFIG_PATH, 'utf8');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (path.dirname(String(to)) === path.resolve(BACKUPS())) throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
      return rename(from, to);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    const reply = await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 } });
    expect(reply.status).toBe(500);
    expect(reply.body.error).toBe('Failed to update config: the backup could not be written (ENOSPC: no space left on device, rename); nothing was saved');
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe(served);
    noTargetWrite();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
});
