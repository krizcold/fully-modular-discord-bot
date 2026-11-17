import path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// The modules read the platform once at load: they load here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import { getNodeId } from '../../src/bot/internalSetup/fleet/nodeIdentity';
import { FLEET_DIR } from '../../src/bot/internalSetup/fleet/constants';
import { FolderSyncError } from '../../src/bot/internalSetup/utils/folderChain';
import { dataPath } from '../../src/utils/dataRoot';

// One file per case: the node id is kept for the life of the module, so each case needs a process of its own.

const NODE_FILE = dataPath('global', FLEET_DIR, 'node.json');
const FLEET = path.resolve(dataPath('global', FLEET_DIR));
const errno = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

describe('a node id whose folder sync failed', () => {
  it('stays the node id for the process, even when node.json cannot be read later', () => {
    fs.rmSync(NODE_FILE, { force: true });
    const fdDir = new Map<number, string>();
    const openSync = fs.openSync;
    const fsyncSync = fs.fsyncSync;
    const closeSync = fs.closeSync;
    let failFleet = true;
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags?: any, ...rest: any[]) => {
      const fd = (openSync as any)(file, flags, ...rest);
      try {
        if ((flags === 'r' || flags === undefined) && fs.statSync(String(file)).isDirectory()) fdDir.set(fd, path.resolve(String(file)));
      } catch { /* not there */ }
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      const dir = fdDir.get(fd);
      if (dir === undefined) return fsyncSync(fd);
      if (dir === FLEET && failFleet) {
        failFleet = false;
        throw errno('EIO');
      }
      return undefined;
    }) as typeof fs.fsyncSync);
    vi.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => { fdDir.delete(fd); return closeSync(fd); }) as typeof fs.closeSync);

    let thrown: unknown = null;
    try {
      getNodeId();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FolderSyncError);
    const written = JSON.parse(fs.readFileSync(NODE_FILE, 'utf8')).nodeId as string;
    expect(written).toMatch(/^[0-9a-f-]{36}$/);

    const readFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: any[]) => {
      if (typeof file === 'string' && path.resolve(file) === path.resolve(NODE_FILE)) throw errno('EIO');
      return (readFileSync as any)(file, ...rest);
    }) as typeof fs.readFileSync);
    expect(getNodeId()).toBe(written);
    expect(getNodeId()).toBe(written);
  });
});
