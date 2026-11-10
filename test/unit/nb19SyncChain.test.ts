import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 decisions 3 and 4 through the real synchronous walk: the folders atomicWriteFileSync syncs after its rename, the
// FolderSyncError a failed fsyncSync gives, and the mirror writers that pass chain false.

const h = vi.hoisted(() => ({
  fdDir: new Map<number, string>(),
  synced: [] as string[],
  failSync: new Map<string, string>(),
}));

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const norm = (p: unknown) => path.resolve(String(p));
  const openSync = (file: any, flags?: any, ...rest: any[]) => {
    const fd = real.openSync(file, flags, ...rest);
    let dir = false;
    try { dir = (flags === 'r' || flags === undefined) && real.statSync(String(file)).isDirectory(); } catch { /* not there */ }
    if (dir) h.fdDir.set(fd, norm(file));
    return fd;
  };
  const fsyncSync = (fd: number) => {
    const dir = h.fdDir.get(fd);
    if (dir !== undefined) {
      h.synced.push(dir);
      const code = h.failSync.get(dir);
      if (code) {
        h.failSync.delete(dir);
        throw Object.assign(new Error(`${code}: i/o error, fsync`), { code });
      }
    }
    return real.fsyncSync(fd);
  };
  const closeSync = (fd: number) => { h.fdDir.delete(fd); return real.closeSync(fd); };
  const over = { openSync, fsyncSync, closeSync };
  return { ...real, ...over, default: { ...real, ...over } };
});

import fs from 'fs';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { atomicWriteFileSync } from '../../src/bot/internalSetup/utils/atomicWrite';
import { FolderSyncError, folderSyncFailed, resetFolderSyncFailureForTests, writtenUnconfirmedText } from '../../src/bot/internalSetup/utils/folderChain';
import { docRecordPath, storeRecordPath, writeDocRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';

const POSIX = process.platform !== 'win32';
const ROOT = path.resolve(DATA_ROOT);
let n = 0;
const fresh = () => `nb19chain-${process.pid}-${Date.now()}-${++n}`;

beforeEach(() => {
  h.synced.length = 0;
  h.failSync.clear();
});

describe.skipIf(!POSIX)('rows 15, 16 and 23: the real synchronous chain', () => {
  it('15: a write into a new folder syncs the folders up to DATA_ROOT; chain false syncs the file\'s folder only', () => {
    const top = fresh();
    atomicWriteFileSync(dataPath(top, 'new', 'a.json'), '{"a":1}');
    expect(h.synced).toEqual([dataPath(top, 'new'), dataPath(top), ROOT]);
    expect(fs.readFileSync(dataPath(top, 'new', 'a.json'), 'utf8')).toBe('{"a":1}');
    h.synced.length = 0;
    atomicWriteFileSync(dataPath(top, 'other', 'b.json'), '{"b":1}', undefined, { chain: false });
    expect(h.synced).toEqual([dataPath(top, 'other')]);
    expect(fs.readFileSync(dataPath(top, 'other', 'b.json'), 'utf8')).toBe('{"b":1}');
  });

  it('16: an fsyncSync EIO on a folder of the chain throws FolderSyncError and sets the flag; the file holds the new bytes', () => {
    const top = fresh();
    const file = dataPath(top, 'new', 'a.json');
    h.failSync.set(dataPath(top), 'EIO');
    let error: unknown;
    try { atomicWriteFileSync(file, '{"new":1}'); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(FolderSyncError);
    expect(error).toMatchObject({ code: 'EIO', kind: 'sync', written: true, file, dir: dataPath(top) });
    expect((error as Error).message).toBe(writtenUnconfirmedText(file, 'sync', dataPath(top), 'EIO'));
    expect(h.synced).toEqual([dataPath(top, 'new'), dataPath(top)]);
    expect(folderSyncFailed()).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"new":1}');
  });

  it('23: the mirror record writers with an fsyncSync EIO on their folder do not throw, and the flag is set', () => {
    const doc = { docs: { 'a.md': { sha: 'd'.repeat(40) } } } as never;
    h.failSync.set(path.resolve(path.dirname(docRecordPath())), 'EIO');
    expect(() => writeDocRecord(doc)).not.toThrow();
    expect(folderSyncFailed()).toBe(true);
    expect(JSON.parse(fs.readFileSync(docRecordPath(), 'utf8'))).toEqual(doc);

    const store = { docs: {}, modules: {}, statusSeq: 3 } as never;
    fs.mkdirSync(path.dirname(storeRecordPath()), { recursive: true });
    resetFolderSyncFailureForTests();
    h.synced.length = 0;
    h.failSync.set(path.resolve(path.dirname(storeRecordPath())), 'EIO');
    expect(() => writeStoreRecord(store)).not.toThrow();
    expect(h.synced).toEqual([path.resolve(path.dirname(storeRecordPath()))]);
    expect(folderSyncFailed()).toBe(true);
    expect(JSON.parse(fs.readFileSync(storeRecordPath(), 'utf8'))).toEqual(store);
  });
});
