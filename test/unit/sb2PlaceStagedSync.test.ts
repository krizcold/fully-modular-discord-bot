import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ synced: [] as string[], fail: null as string | null }));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      const at = path.resolve(dir);
      h.synced.push(at);
      if (h.fail === at) return { failed: true, kind: 'sync', dir: at, errno: 'EIO', error: null };
      return { failed: false };
    },
  };
});

import { placeStaged } from '../../src/bot/internalSetup/utils/dataMigration';
import { root } from '../helpers/migrationRig';

// placeStaged syncs the folder chain of every folder a move took an entry from or put one into; a failed sync fails
// the placement with T20 and keeps the staging folder.

const G = '830000000000000001';
const base = path.join(root, 'sb2-place');
const dataRoot = path.join(base, 'data');
const staging = path.join(dataRoot, '.migrate-sb2');
const superseded = path.join(dataRoot, '_superseded', 'sb2');

function seed(): void {
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataRoot, G, 'mod'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, G, 'mod', 'a.json'), '{"old":1}');
  fs.mkdirSync(path.join(staging, G, 'mod'), { recursive: true });
  fs.writeFileSync(path.join(staging, G, 'mod', 'a.json'), '{"new":1}');
}

beforeEach(() => {
  h.synced.length = 0;
  h.fail = null;
  seed();
});
afterEach(() => {
  h.fail = null;
  fs.rmSync(base, { recursive: true, force: true });
});

describe('placeStaged folder syncs', () => {
  it('syncs the chain of the data root, the superseded folder and the staging folder after the moves', async () => {
    await placeStaged(dataRoot, staging, superseded);
    expect(fs.readFileSync(path.join(dataRoot, G, 'mod', 'a.json'), 'utf-8')).toBe('{"new":1}');
    expect(fs.readFileSync(path.join(superseded, G, 'mod', 'a.json'), 'utf-8')).toBe('{"old":1}');
    expect(new Set(h.synced)).toEqual(new Set([path.resolve(dataRoot), path.resolve(superseded), path.resolve(staging)]));
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('a failed sync of the data root rejects with T20 and keeps the staging folder', async () => {
    h.fail = path.resolve(dataRoot);
    const error = await placeStaged(dataRoot, staging, superseded).then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe(`the migration's folders can't be confirmed as stored: the disk did not confirm the sync of ${path.resolve(dataRoot)} (EIO). Check the disk, then restart the machine.`);
    expect(fs.existsSync(staging)).toBe(true);
    expect(fs.readFileSync(path.join(dataRoot, G, 'mod', 'a.json'), 'utf-8')).toBe('{"new":1}');
    expect(fs.readFileSync(path.join(superseded, G, 'mod', 'a.json'), 'utf-8')).toBe('{"old":1}');
  });
});
