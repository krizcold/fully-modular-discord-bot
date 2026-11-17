import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The modules read the platform once at load: they load here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import { fsyncDataDirsSync, writeGraveyardNoteSync } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';

let guilds = 871_400_000_000_000_000n;
const freshGuild = () => String(++guilds);
let synced: string[] = [];

/** Folder fsyncs through the sync calls are recorded and succeed (the host's own folder fsync is not what Linux does). */
function fakeFolderSyncs(): void {
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
      synced.push(dir);
      return undefined;
    }
    return fsyncSync(fd);
  }) as typeof fs.fsyncSync);
  vi.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => { fdDir.delete(fd); return closeSync(fd); }) as typeof fs.closeSync);
}

beforeEach(() => {
  synced = [];
  fs.mkdirSync(dataPath('_graveyard'), { recursive: true });
  fakeFolderSyncs();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

describe('the boot sync calls of the graveyard', () => {
  it('writeGraveyardNoteSync writes the note whole and syncs the entry folder that holds it', () => {
    const g = freshGuild();
    const entry = dataPath('_graveyard', `${g}-1000`);
    fs.mkdirSync(entry, { recursive: true });
    writeGraveyardNoteSync(entry, { guildId: g, reason: 'replaced-by-restore-7', ts: 1000 });
    expect(JSON.parse(fs.readFileSync(path.join(entry, '.graveyard.json'), 'utf8'))).toEqual({ guildId: g, reason: 'replaced-by-restore-7', ts: 1000 });
    expect(synced).toEqual([path.resolve(entry)]);
  });

  it('fsyncDataDirsSync syncs /data and then /data/_graveyard', () => {
    fsyncDataDirsSync();
    expect(synced).toEqual([path.resolve(DATA_ROOT), path.resolve(dataPath('_graveyard'))]);
  });
});
