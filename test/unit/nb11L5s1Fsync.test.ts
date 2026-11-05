import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsyncDataDirs } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DATA_ROOT } from '../../src/utils/dataRoot';

// NB11 (sheets/NB11.md): after a move between /data and /data/_graveyard, both folders are fsynced on POSIX so the
// rename survives a power cut; Windows has no directory fsync, so nothing is opened there.

afterEach(() => vi.restoreAllMocks());

describe('fsyncDataDirs on this platform', () => {
  it('syncs and closes /data and /data/_graveyard on POSIX, and opens nothing on Windows', async () => {
    const handles: { dir: string; flags: unknown; sync: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any) => {
      const handle = { dir: path.resolve(String(p)), flags, sync: vi.fn(async () => {}), close: vi.fn(async () => {}) };
      handles.push(handle);
      return handle;
    }) as any);
    await fsyncDataDirs();
    if (process.platform === 'win32') {
      expect(handles).toEqual([]);
      return;
    }
    expect(handles.map(h => [h.dir, h.flags])).toEqual([
      [path.resolve(DATA_ROOT), 'r'],
      [path.resolve(DATA_ROOT, '_graveyard'), 'r'],
    ]);
    for (const h of handles) {
      expect(h.sync).toHaveBeenCalledTimes(1);
      expect(h.close).toHaveBeenCalledTimes(1);
    }
  });
});
