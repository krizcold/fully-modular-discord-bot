import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ folderSyncs: [] as string[], chains: [] as string[] }));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderSync: (dir: string) => {
      h.folderSyncs.push(path.resolve(dir));
      return real.syncFolderSync(dir);
    },
    syncFolderChainSync: (dir: string) => {
      h.chains.push(path.resolve(dir));
      return real.syncFolderChainSync(dir);
    },
  };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { atomicWriteFileSync } from '../../src/bot/internalSetup/utils/atomicWrite';

afterEach(() => {
  h.folderSyncs.length = 0;
  h.chains.length = 0;
});

describe('atomicWriteFileSync with chain false', () => {
  it('writes the bytes and syncs the file\'s own folder once, with no chain', () => {
    const file = dataPath('sa4', 'mirror', 'a.json');
    atomicWriteFileSync(file, '{"sa4":1}', undefined, { chain: false });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"sa4":1}');
    expect(h.folderSyncs).toEqual([path.resolve(path.dirname(file))]);
    expect(h.chains).toEqual([]);
  });
});
