import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 row 23 through the mirror callers of a Postgres bot: each mirror write syncs its own folder only, a folder sync
// EIO throws nothing (as before NB19), and the flag is set. The synchronous writes are sharedStore's App Store landing
// and the pass's App Store key; the asynchronous ones go through atomicReplace from the flush and from the pass.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { folderSyncFailed } from '../../src/bot/internalSetup/utils/folderChain';
import { landStoreDoc } from '../../src/bot/internalSetup/utils/sharedStore';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { mirrorRig, text } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';

const POSIX = process.platform !== 'win32';
const STORE = path.resolve(dataPath('global', 'appstore'));
const m = mirrorRig('nb19mirror');
const CAT = path.resolve(dataPath('global', 'nb19mirror'));

/** Folder syncs of this test, sync and async, and the folders whose sync answers EIO once. */
const seen = { synced: [] as string[], fail: new Set<string>() };
/** A mirror write that threw is logged with its file and retried; none may be. */
const failLines = (file: string) => m.state.lines.filter(l => l.includes(file) && /could not write|Could not write/.test(l));

function spyFolderSyncs(): void {
  const fdDir = new Map<number, string>();
  const openSync = fs.openSync;
  const fsyncSync = fs.fsyncSync;
  const closeSync = fs.closeSync;
  vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags?: any, ...rest: any[]) => {
    const fd = (openSync as any)(file, flags, ...rest);
    try {
      if ((flags === 'r' || flags === undefined) && fs.statSync(String(file)).isDirectory()) fdDir.set(fd, path.resolve(String(file)));
    } catch { /* not there */ }
    return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
    const dir = fdDir.get(fd);
    if (dir !== undefined) {
      seen.synced.push(dir);
      if (seen.fail.delete(dir)) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    }
    return fsyncSync(fd);
  }) as typeof fs.fsyncSync);
  vi.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => { fdDir.delete(fd); return closeSync(fd); }) as typeof fs.closeSync);
  const open = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike, flags?: any, mode?: any) => {
    const handle = await (open as any)(file, flags, mode);
    let dir = false;
    try { dir = (flags === 'r' || flags === undefined) && fs.statSync(String(file)).isDirectory(); } catch { /* not there */ }
    if (!dir) return handle;
    const at = path.resolve(String(file));
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      seen.synced.push(at);
      if (seen.fail.delete(at)) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
      return sync();
    };
    return handle;
  }) as typeof fs.promises.open);
}

beforeEach(async () => {
  await m.setup();
  seen.synced.length = 0;
  seen.fail.clear();
  fs.mkdirSync(STORE, { recursive: true });
  fs.mkdirSync(CAT, { recursive: true });
});
afterEach(async () => { await m.teardown(); });

describe.skipIf(!POSIX)('row 23: the mirror callers with a folder sync EIO', () => {
  it('sharedStore\'s App Store landing (writeStoreKey): no throw, its folder only, the file holds the bytes, the flag set', () => {
    const body = Buffer.from(text({ v: 1 }));
    const file = path.join(STORE, 'nb19-land.json');
    spyFolderSyncs();
    seen.fail.add(STORE);
    expect(() => landStoreDoc('global/appstore/nb19-land.json', body, sha(body), null)).not.toThrow();
    expect(fs.readFileSync(file).equals(body)).toBe(true);
    expect(seen.synced).toEqual([STORE]);
    expect(folderSyncFailed()).toBe(true);
    expect(failLines(file)).toEqual([]);
  });

  it('the flush\'s mirror write (atomicReplace): the op lands, its folder only, the file holds the bytes, the flag set', async () => {
    spyFolderSyncs();
    seen.fail.add(CAT);
    await m.landed('k.json', { v: 1 });
    expect(m.read('k.json')).toBe(text({ v: 1 }));
    expect(seen.synced).toEqual([CAT]);
    expect(folderSyncFailed()).toBe(true);
    expect(failLines(m.file('k.json'))).toEqual([]);
  });

  it('the pass\'s App Store key (applyStoreKey): no throw, its folder only, the file holds the row, the flag set', async () => {
    m.state.rows.put('global/appstore/nb19-pass.json', text({ p: 1 }));
    spyFolderSyncs();
    seen.fail.add(STORE);
    await runSharedPass();
    expect(fs.readFileSync(path.join(STORE, 'nb19-pass.json'), 'utf8')).toBe(text({ p: 1 }));
    expect(seen.synced[0]).toBe(STORE);
    expect(seen.synced.every(d => d === STORE || !STORE.startsWith(d + path.sep))).toBe(true);
    expect(folderSyncFailed()).toBe(true);
    expect(failLines(path.join(STORE, 'nb19-pass.json'))).toEqual([]);
  });

  it('the pass\'s mirror write of another key (atomicReplace): its folder only, the file holds the row, the flag set', async () => {
    m.state.rows.put(m.keyOf('p.json'), text({ p: 2 }));
    spyFolderSyncs();
    seen.fail.add(CAT);
    await runSharedPass();
    expect(m.read('p.json')).toBe(text({ p: 2 }));
    expect(seen.synced[0]).toBe(CAT);
    expect(seen.synced.every(d => d === CAT || !CAT.startsWith(d + path.sep))).toBe(true);
    expect(folderSyncFailed()).toBe(true);
    expect(failLines(m.file('p.json'))).toEqual([]);
  });
});
