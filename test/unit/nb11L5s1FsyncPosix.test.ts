import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// The module reads the platform once at load: it loads here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

import { fsyncDataDirs } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DATA_ROOT } from '../../src/utils/dataRoot';

// NB11 (sheets/NB11.md): after a move between /data and /data/_graveyard, both folders are fsynced so the rename
// survives a power cut. A folder that cannot be opened or synced is passed over: the fsync is best-effort.

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

type Handle = { dir: string; flags: unknown; sync: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
function fakeOpen(syncFails: (dir: string) => boolean = () => false): Handle[] {
  const handles: Handle[] = [];
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any) => {
    const dir = path.resolve(String(p));
    const handle = {
      dir,
      flags,
      sync: vi.fn(async () => { if (syncFails(dir)) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); }),
      close: vi.fn(async () => {}),
    };
    handles.push(handle);
    return handle;
  }) as any);
  return handles;
}

describe('fsyncDataDirs on Linux', () => {
  it('opens /data and /data/_graveyard read-only, syncs each and closes each', async () => {
    const handles = fakeOpen();
    await fsyncDataDirs();
    expect(handles.map(h => [h.dir, h.flags])).toEqual([
      [path.resolve(DATA_ROOT), 'r'],
      [path.resolve(DATA_ROOT, '_graveyard'), 'r'],
    ]);
    for (const h of handles) {
      expect(h.sync).toHaveBeenCalledTimes(1);
      expect(h.close).toHaveBeenCalledTimes(1);
    }
  });

  it('closes a folder whose sync fails and still syncs the next one', async () => {
    const handles = fakeOpen(dir => dir === path.resolve(DATA_ROOT));
    await expect(fsyncDataDirs()).resolves.toBeUndefined();
    expect(handles).toHaveLength(2);
    expect(handles[0].close).toHaveBeenCalledTimes(1);
    expect(handles[1].sync).toHaveBeenCalledTimes(1);
    expect(handles[1].close).toHaveBeenCalledTimes(1);
  });
});
