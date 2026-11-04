import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listJsonUnits, moveEarlierStaging, placeStaged, readJsonUnit, snapshotFromPgRows, stageSnapshot, type Snapshot,
} from '../../src/bot/internalSetup/utils/dataMigration';
import { root, wipeRoot } from '../helpers/migrationRig';

// NB3 mutation gate, chunk 2: the JSON side of the job (which folders count as guilds and graveyard entries, the strict
// walk's refusals), the staging folder and its fsync, and the moves of earlier staging folders and stale guild folders.

const G = '660000000000000001';
const G2 = '660000000000000002';

beforeEach(() => wipeRoot());
afterEach(() => vi.restoreAllMocks());

const dirIn = (...parts: string[]) => {
  const full = path.join(...parts);
  fs.mkdirSync(full, { recursive: true });
  return full;
};
const fileIn = (full: string, text = '{}') => {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
};

describe('NB3 L5 s2: which folders under the data root are guilds and graveyard entries', () => {
  it('skips a folder whose name only starts or ends in digits, with nothing left out', async () => {
    const src = dirIn(root, 'src');
    dirIn(src, 'x1');
    dirIn(src, '1x');
    fileIn(path.join(src, G, 'm', 'a.json'));
    const leftOut: string[] = [];
    const units = await listJsonUnits(src, leftOut);
    expect(units).toEqual([{ guildId: G, dir: path.join(src, G) }]);
    expect(leftOut).toEqual([]);
  });

  it('takes the largest bigint as a guild id and leaves out one past it', async () => {
    const src = dirIn(root, 'src');
    dirIn(src, '9223372036854775807');
    dirIn(src, '9223372036854775808');
    const leftOut: string[] = [];
    const units = await listJsonUnits(src, leftOut);
    expect(units).toEqual([{ guildId: '9223372036854775807', dir: path.join(src, '9223372036854775807') }]);
    expect(leftOut).toEqual([path.join(src, '9223372036854775808')]);
  });

  it('refuses a _graveyard that is a file, naming it as not a folder', async () => {
    const src = dirIn(root, 'src');
    const grave = fileIn(path.join(src, '_graveyard'), 'x');
    await expect(listJsonUnits(src, [])).rejects.toThrow(`${grave} is a link or another entry that is not a folder, so its data cannot be copied exactly`);
  });

  it('leaves out a graveyard entry whose name has text before or after <guild>-<time>', async () => {
    const src = dirIn(root, 'src');
    const a = dirIn(src, '_graveyard', 'x1-2');
    const b = dirIn(src, '_graveyard', '1-2x');
    dirIn(src, '_graveyard', `${G}-100`);
    const leftOut: string[] = [];
    const units = await listJsonUnits(src, leftOut);
    expect(units).toEqual([{ guildId: G, retiredAt: 100, dir: path.join(src, '_graveyard', `${G}-100`) }]);
    expect([...leftOut].sort()).toEqual([a, b].sort());
  });

  it('refuses a data root it cannot read, naming the folder and the error', async () => {
    const missing = path.join(root, 'no-such-root');
    await expect(listJsonUnits(missing, [])).rejects.toThrow(new RegExp(`^The folder ${missing.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} cannot be read: .*ENOENT`));
  });

  it('lists guilds in name order whatever order the folder listing gives', async () => {
    const src = dirIn(root, 'src');
    dirIn(src, G);
    dirIn(src, G2);
    const realReaddir = fs.promises.readdir;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, opts?: any) => {
      const names = await (realReaddir as any)(p, opts);
      return [...names].reverse();
    }) as any);
    const units = await listJsonUnits(src, []);
    expect(units.map(u => u.guildId)).toEqual([G, G2]);
  });
});

describe('NB3 L5 s2: the strict walk of a guild folder', () => {
  it('refuses an entry it cannot stat, naming the path and the error', async () => {
    const dir = dirIn(root, G);
    const target = fileIn(path.join(dir, 'm', 'a.json'));
    const realLstat = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(target)) throw new Error('EACCES: permission denied');
      return (realLstat as any)(p, ...rest);
    }) as any);
    await expect(readJsonUnit({ guildId: G, dir })).rejects.toThrow(`${target} cannot be read: EACCES: permission denied`);
  });

  it('refuses an entry that is neither a regular file, a folder nor a link (a FIFO or a socket)', async () => {
    const dir = dirIn(root, G);
    const target = fileIn(path.join(dir, 'm', 'a.json'));
    const realLstat = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(target)) return { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false };
      return (realLstat as any)(p, ...rest);
    }) as any);
    await expect(readJsonUnit({ guildId: G, dir })).rejects.toThrow(`${target} is neither a regular file nor a folder`);
  });
});

describe('NB3 L5 s2: guild ids in Postgres rows', () => {
  it('refuses a guild id with text before its digits as not a guild id', () => {
    expect(() => snapshotFromPgRows([{ guild_id: 'a1', module: 'm', filename: 'a.json', doc: '{}' }], [], []))
      .toThrow('The database holds rows of "a1", which is not a guild id; nothing was written');
  });

  it('refuses a guild id with text after its digits as not a guild id', () => {
    expect(() => snapshotFromPgRows([{ guild_id: '1a', module: 'm', filename: 'a.json', doc: '{}' }], [], []))
      .toThrow('The database holds rows of "1a", which is not a guild id; nothing was written');
  });
});

function oneItem(module: string, filename: string, bytes = '{"v":1}'): Snapshot {
  return {
    items: [{ guildId: G, grave: false, module, filename, kind: 'doc', bytes: Buffer.from(bytes) }],
    graves: [], guilds: [G], leftOut: [], shadow: [],
  };
}

describe('NB3 L5 s2: the staging folder', () => {
  it('writes a document at the guild folder\'s root under its file name alone', async () => {
    const staging = path.join(root, '.migrate-1');
    await stageSnapshot(oneItem('', 'top.json', '{"top":1}'), staging);
    expect(fs.readFileSync(path.join(staging, G, 'top.json'), 'utf8')).toBe('{"top":1}');
    expect(fs.readdirSync(path.join(staging, G))).toEqual(['top.json']);
  });

  it('opens the staging folder for reading and fsyncs it once its files are written', async () => {
    const staging = path.join(root, '.migrate-2');
    const opened: Array<[string, string]> = [];
    const synced: string[] = [];
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags?: any, ...rest: any[]) => {
      opened.push([path.resolve(String(p)), String(flags)]);
      const handle = await (realOpen as any)(p, flags, ...rest);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        synced.push(path.resolve(String(p)));
        return realSync();
      };
      return handle;
    }) as any);
    await stageSnapshot(oneItem('m', 'a.json'), staging);
    expect(opened).toContainEqual([path.resolve(staging), 'r']);
    expect(synced).toContain(path.resolve(staging));
    expect(synced).toContain(path.resolve(path.join(staging, G, 'm', 'a.json')));
  });
});

describe('NB3 L5 s2: an earlier run\'s staging folders', () => {
  it('moves every earlier staging folder but the current one, a .tmp one and a plain file, and names what it moved', async () => {
    const src = dirIn(root, 'src');
    const superseded = path.join(root, 'sup');
    const old = dirIn(src, '.migrate-1');
    fileIn(path.join(old, G, 'a.json'), 'old');
    const current = dirIn(src, '.migrate-2');
    const tmpInside = dirIn(src, '.migrate-3.tmpx');
    dirIn(src, '.migrate-4.tmp');
    const plainFile = fileIn(path.join(src, '.migrate-file'), 'f');
    const moved = await moveEarlierStaging(src, superseded, current);
    expect([...moved].sort()).toEqual([old, tmpInside].sort());
    expect(fs.readFileSync(path.join(superseded, '.migrate-1', G, 'a.json'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(superseded, '.migrate-3.tmpx'))).toBe(true);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(plainFile)).toBe(true);
    expect(fs.existsSync(path.join(superseded, '.migrate-2'))).toBe(false);
    expect(fs.existsSync(path.join(superseded, '.migrate-file'))).toBe(false);
  });

  it('with no current folder, moves the earlier one and answers its path alone', async () => {
    const src = dirIn(root, 'src');
    const superseded = path.join(root, 'sup');
    const old = dirIn(src, '.migrate-1');
    expect(await moveEarlierStaging(src, superseded)).toEqual([old]);
    expect(fs.existsSync(path.join(superseded, '.migrate-1'))).toBe(true);
  });

  it('refuses when the superseded folder already holds that name, and moves nothing', async () => {
    const src = dirIn(root, 'src');
    const superseded = path.join(root, 'sup');
    const old = dirIn(src, '.migrate-1');
    fileIn(path.join(old, 'mine.json'), 'mine');
    const taken = dirIn(superseded, '.migrate-1');
    fileIn(path.join(taken, 'theirs.json'), 'theirs');
    await expect(moveEarlierStaging(src, superseded)).rejects.toThrow(`${taken} exists; nothing was moved`);
    expect(fs.readFileSync(path.join(old, 'mine.json'), 'utf8')).toBe('mine');
    expect(fs.readdirSync(taken)).toEqual(['theirs.json']);
  });
});

describe('NB3 L5 s2: placing a staged copy', () => {
  it('moves only folders named by digits alone aside, and makes no graveyard folder when no entry comes in', async () => {
    const data = dirIn(root, 'data');
    const staging = dirIn(root, 'staging');
    const superseded = path.join(root, 'sup');
    fileIn(path.join(data, '1x', 'keep.json'), 'keep');
    fileIn(path.join(data, G, 'm', 'a.json'), 'stale');
    fileIn(path.join(staging, G, 'm', 'a.json'), 'new');
    await placeStaged(data, staging, superseded);
    expect(fs.readFileSync(path.join(data, '1x', 'keep.json'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(superseded, '1x'))).toBe(false);
    expect(fs.readFileSync(path.join(data, G, 'm', 'a.json'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(superseded, G, 'm', 'a.json'), 'utf8')).toBe('stale');
    expect(fs.existsSync(path.join(data, '_graveyard'))).toBe(false);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('refuses when a guild\'s target is a file and not a folder it moves aside, and moves nothing', async () => {
    const data = dirIn(root, 'data');
    const staging = dirIn(root, 'staging');
    const superseded = path.join(root, 'sup');
    const blocker = fileIn(path.join(data, G), 'a file');
    fileIn(path.join(data, G2, 'm', 'a.json'), 'other');
    fileIn(path.join(staging, G, 'm', 'a.json'), 'new');
    await expect(placeStaged(data, staging, superseded)).rejects.toThrow(`${blocker} exists; nothing was moved`);
    expect(fs.readFileSync(blocker, 'utf8')).toBe('a file');
    expect(fs.readFileSync(path.join(data, G2, 'm', 'a.json'), 'utf8')).toBe('other');
    expect(fs.existsSync(superseded)).toBe(false);
    expect(fs.readFileSync(path.join(staging, G, 'm', 'a.json'), 'utf8')).toBe('new');
  });
});
