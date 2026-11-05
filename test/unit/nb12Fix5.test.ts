import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { readRawStrict, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { setBackendKind } from '../helpers/backendKind';
import { REAL_FS } from '../helpers/forwardingFs';

// NB12 code review round 5 (wip-redesign/sheets/NB12.md): a case alias of a folder on k's path is in k's way only when
// k's exact spelling of that folder is not on disk, and never when it holds keys (NB12-P-R5-1, NB12-OPS-R5-1,
// NB12-T-R5-1); under a guild folder, a file at one of k's folders reads as absent, so updateData reaches fn and P
// (NB12-INV3-R5-2).

let guilds = 9_500_000_000;
let errors: string[];
const real = (fs as any)[REAL_FS];

beforeEach(() => {
  errors = [];
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dm.flushAll();
  setGuildViewCache(false);
});

const dirent = (name: string, dir: boolean) => ({ name, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false });

/**
 * A guild holding 'm/a.json' and 'M/b.json' as a case-sensitive disk keeps them. The real disk here may fold case, so
 * 'M' is kept on disk as 'UPPER_M' and every fs call for the exact path of 'M' (or below it) goes there.
 */
function pairGuild(cache: boolean) {
  setGuildViewCache(cache);
  const guildId = String(++guilds);
  const p = (...rel: string[]) => dataPath(guildId, ...rel);
  fs.mkdirSync(p('m'), { recursive: true });
  fs.mkdirSync(p('UPPER_M'), { recursive: true });
  fs.writeFileSync(p('m', 'a.json'), '1');
  fs.writeFileSync(p('UPPER_M', 'b.json'), '2');
  const upper = p('M');
  const redirect = (x: unknown): unknown => {
    if (typeof x !== 'string') return x;
    const abs = path.resolve(x);
    if (abs === upper) return p('UPPER_M');
    if (abs.startsWith(upper + path.sep)) return p('UPPER_M') + abs.slice(upper.length);
    return x;
  };
  const touched: string[] = [];
  vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: string, options?: any) => {
    const to = redirect(dir);
    const list = real.readdirSync(to, options);
    if (path.resolve(dir) !== p() || !options?.withFileTypes) return list;
    return list.map((e: fs.Dirent) => (e.name === 'UPPER_M' ? dirent('M', true) : e));
  }) as never);
  for (const fn of ['rmdirSync', 'unlinkSync', 'lstatSync', 'statSync', 'existsSync', 'readFileSync'] as const) {
    vi.spyOn(fs, fn).mockImplementation(((x: string, ...rest: unknown[]) => {
      const to = redirect(x);
      if (to !== x && (fn === 'rmdirSync' || fn === 'unlinkSync')) touched.push(path.resolve(x));
      return real[fn](to, ...rest);
    }) as never);
  }
  return { guildId, o: { guildId, category: 'm' } as dm.DataOptions, p, removals: () => touched };
}

describe.each([true, false])("a guild holding 'm/a.json' and 'M/b.json' (cache %s)", cache => {
  it("a new key 'm/x.json' is saved, lands, and no refusal names 'M'", async () => {
    const r = pairGuild(cache);
    expect(dm.saveDataTracked('x.json', r.o, 7).outcome).toBe('saved');
    await dm.flushAll();
    expect(real.readFileSync(r.p('m', 'x.json'), 'utf8')).toBe('7');
    expect(real.readFileSync(r.p('UPPER_M', 'b.json'), 'utf8')).toBe('2');
    expect(errors.filter(e => e.includes('the folder M'))).toEqual([]);
  });

  it("an overwrite of 'm/a.json' is saved and 'M/b.json' keeps its bytes", async () => {
    const r = pairGuild(cache);
    expect(dm.saveDataTracked('a.json', r.o, 8).outcome).toBe('saved');
    await dm.flushAll();
    expect(real.readFileSync(r.p('m', 'a.json'), 'utf8')).toBe('8');
    expect(real.readdirSync(r.p('UPPER_M'))).toEqual(['b.json']);
    expect(real.readFileSync(r.p('UPPER_M', 'b.json'), 'utf8')).toBe('2');
  });

  it("no rmdir or unlink reaches 'M' for a write under 'm'", () => {
    const r = pairGuild(cache);
    expect(dm.saveDataTracked('y.json', r.o, 1).outcome).toBe('saved');
    expect(r.removals()).toEqual([]);
  });
});

describe('a file at one of the folders of an updated key (ENOTDIR on Linux)', () => {
  function fileAtFolder() {
    setGuildViewCache(true);
    const guildId = String(++guilds);
    fs.mkdirSync(dataPath(guildId, 'm'), { recursive: true });
    fs.writeFileSync(dataPath(guildId, 'm', 'a'), '{"k":1}');
    const target = dataPath(guildId, 'm', 'a', 'x.json');
    vi.spyOn(fs, 'readFileSync').mockImplementation(((x: string, ...rest: unknown[]) => {
      if (path.resolve(x) === target) throw Object.assign(new Error(`ENOTDIR: not a directory, open '${x}'`), { code: 'ENOTDIR' });
      return real.readFileSync(x, ...rest);
    }) as never);
    return { guildId, target };
  }

  it("updateData of 'a/x.json' in category 'm' answers unstorable with the reason, runs fn once, and 'm/a' keeps its bytes", async () => {
    const { guildId } = fileAtFolder();
    const seen: unknown[] = [];
    const answer = dm.updateData('a/x.json', { guildId, category: 'm' }, {}, current => { seen.push(current); return { v: 1 }; });
    expect(answer).toEqual({ outcome: 'refused', cause: 'unstorable', reason: 'the folder m/a of it is a file' });
    expect(seen).toEqual([{}]);
    expect(dm.saveDataTracked('a/x.json', { guildId, category: 'm' }, { v: 1 })).toEqual(answer);
    await dm.flushAll();
    expect(real.readFileSync(dataPath(guildId, 'm', 'a'), 'utf8')).toBe('{"k":1}');
  });

  it('readRawStrict answers absent under a guild folder', () => {
    const { target } = fileAtFolder();
    expect(readRawStrict(target)).toBeNull();
  });

  it('readRawStrict still throws ENOTDIR outside a guild folder', () => {
    const target = dataPath('_nb12fix5', 'a', 'x.json');
    fs.mkdirSync(dataPath('_nb12fix5'), { recursive: true });
    vi.spyOn(fs, 'readFileSync').mockImplementation(((x: string, ...rest: unknown[]) => {
      if (path.resolve(x) === target) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
      return real.readFileSync(x, ...rest);
    }) as never);
    expect(() => readRawStrict(target)).toThrow('ENOTDIR');
  });
});
