import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  placeStaged, readJsonUnit, readStoreList, snapshotHashes, stageSnapshot, walkJsonSource, type Snapshot,
} from '../../src/bot/internalSetup/utils/dataMigration';
import { root, STORES, wipeRoot } from '../helpers/migrationRig';

const G = '770000000000000001';

beforeEach(() => wipeRoot());
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe('the store list read', () => {
  it('a read of .stores.json that throws a non-Error value refuses naming the file, not with a TypeError', () => {
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(STORES)) throw undefined;
      return (real as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    let caught: unknown;
    try { readStoreList(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).toMatch(/\.stores\.json cannot be read: undefined$/);
  });
});

describe('snapshotHashes keys for shadow rows', () => {
  const snap = (): Snapshot => ({
    items: [], graves: [], guilds: [], leftOut: [],
    shadow: [
      { guildId: '1', module: 'M', filename: 'f.json', bytes: Buffer.from('{"a":1}') },
      { guildId: '2', retiredAt: 5, module: 'M', filename: 'f.json', bytes: Buffer.from('{"b":2}') },
    ],
  });

  it('a live shadow row is keyed as shadow under its bare guild id; a retired one under guild-retiredAt', () => {
    const keys = [...snapshotHashes(snap()).keys()].sort();
    expect(keys).toEqual([
      JSON.stringify(['shadow', '1', 'M', 'f.json']),
      JSON.stringify(['shadow', '2-5', 'M', 'f.json']),
    ].sort());
  });
});

describe('JSON items read from disk', () => {
  it('a live item carries no retiredAt property at all', async () => {
    const dir = path.join(root, 'data', G);
    fs.mkdirSync(path.join(dir, 'mod'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mod', 'a.json'), '{"x":1}');
    const unit = await readJsonUnit({ guildId: G, dir });
    expect(unit.items).toHaveLength(1);
    expect(Object.hasOwn(unit.items[0], 'retiredAt')).toBe(false);
    expect(unit.items[0]).toStrictEqual({
      guildId: G, module: 'mod', filename: 'a.json', bytes: Buffer.from('{"x":1}'), kind: 'doc', grave: false,
    });
    const walked = await walkJsonSource(path.join(root, 'data'));
    expect(Object.keys(walked.items[0]).sort()).toEqual(['bytes', 'filename', 'grave', 'guildId', 'kind', 'module']);
  });
});

describe('placeStaged', () => {
  it('resolves when the staging folder is already gone at its final removal', async () => {
    const data = path.join(root, 'data');
    fs.mkdirSync(data, { recursive: true });
    const staging = path.join(root, 'staging');
    const superseded = path.join(root, 'superseded');
    await stageSnapshot({ items: [], graves: [], guilds: [], leftOut: [], shadow: [] }, staging);
    await expect(placeStaged(data, staging, superseded, () => fs.rmSync(staging, { recursive: true }))).resolves.toBeUndefined();
    expect(fs.existsSync(staging)).toBe(false);
  });
});
