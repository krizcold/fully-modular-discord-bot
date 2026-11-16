import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// The module reads the platform once at load: it loads here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

import { folderSyncFailed, resetFolderSyncFailureForTests, syncFolder } from '../../src/bot/internalSetup/utils/folderChain';

const errno = (code: string) => Object.assign(new Error(`stubbed ${code}`), { code });

afterEach(() => {
  vi.restoreAllMocks();
  resetFolderSyncFailureForTests();
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

describe('a folder that cannot be opened for its sync with an error that means the sync does not apply', () => {
  for (const code of ['EISDIR', 'EPERM', 'EACCES']) {
    it(`answers not failed for ${code}, opens the folder once and sets no flag`, async () => {
      const opened: string[] = [];
      vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any) => {
        opened.push(String(p));
        throw errno(code);
      }) as any);
      const dir = path.resolve('sb3-folder');
      await expect(syncFolder(dir)).resolves.toEqual({ failed: false });
      expect(opened).toEqual([dir]);
      expect(folderSyncFailed()).toBe(false);
    });
  }

  it('answers an open failure for an error outside that set', async () => {
    vi.spyOn(fs.promises, 'open').mockImplementation((async () => { throw errno('ENOENT'); }) as any);
    const dir = path.resolve('sb3-folder');
    await expect(syncFolder(dir)).resolves.toMatchObject({ failed: true, kind: 'open', dir, errno: 'ENOENT' });
  });
});
