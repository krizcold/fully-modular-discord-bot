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
const errno = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

describe('a node id that could not be written', () => {
  it('is not kept: the next call writes a node id and answers the one node.json holds', () => {
    fs.rmSync(NODE_FILE, { force: true });
    const fdDir = new Set<number>();
    const openSync = fs.openSync;
    const fsyncSync = fs.fsyncSync;
    const closeSync = fs.closeSync;
    let failTemp = true;
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags?: any, ...rest: any[]) => {
      if (failTemp && String(file).startsWith(`${NODE_FILE}.`)) {
        failTemp = false;
        throw errno('ENOSPC');
      }
      const fd = (openSync as any)(file, flags, ...rest);
      try {
        if ((flags === 'r' || flags === undefined) && fs.statSync(String(file)).isDirectory()) fdDir.add(fd);
      } catch { /* not there */ }
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => (fdDir.has(fd) ? undefined : fsyncSync(fd))) as typeof fs.fsyncSync);
    vi.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => { fdDir.delete(fd); return closeSync(fd); }) as typeof fs.closeSync);

    let thrown: unknown = null;
    try {
      getNodeId();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string } | null)?.code).toBe('ENOSPC');
    expect(thrown).not.toBeInstanceOf(FolderSyncError);
    expect(fs.existsSync(NODE_FILE)).toBe(false);

    const id = getNodeId();
    expect(JSON.parse(fs.readFileSync(NODE_FILE, 'utf8')).nodeId).toBe(id);
    expect(fs.readdirSync(path.dirname(NODE_FILE)).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });
});
