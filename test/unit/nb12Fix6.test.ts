import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { KeyTree } from '../../src/bot/internalSetup/utils/storableData';
import { setBackendKind } from '../helpers/backendKind';
import { REAL_FS } from '../helpers/forwardingFs';
import { tokenFor } from '../helpers/fakeStore';
import { ServerStore } from '../helpers/serverStore';

// NB12 code review round 6 (wip-redesign/sheets/NB12.md decision 8, NB12-P-R6-1): a folder of k stored under its
// exact spelling is not an alias, also when the guild holds a file whose name differs from it only in letter case.

let guilds = 9_600_000_000;
const real = (fs as any)[REAL_FS];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dm.flushAll();
  setGuildViewCache(false);
});

describe("KeyTree with the file 'M' and 'm/a.json'", () => {
  const tree = () => {
    const t = new KeyTree();
    t.add('M');
    t.add('m/a.json');
    return t;
  };

  it("passes a new key under m/ and an overwrite of 'm/a.json'", () => {
    expect(tree().check('m/x.json')).toBeNull();
    expect(tree().check('m/sub/y.json')).toBeNull();
    expect(tree().check('m/a.json')).toBeNull();
  });

  it("refuses a key under M/, naming the file M", () => {
    expect(tree().check('M/y.json')).toEqual({ reason: 'the folder M of it is a file', entry: 'M', entryKind: 'file' });
  });

  it('refuses a key under a third spelling, naming a stored one', () => {
    expect(tree().check('m2/x.json')).toBeNull();
    const t = new KeyTree();
    t.add('M');
    t.add('m/a.json');
    t.add('mm/b.json');
    expect(t.check('Mm/x.json')?.reason).toBe('it differs only in letter case from mm');
  });
});

const dirent = (name: string, dir: boolean) => ({ name, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false });

/** A guild holding the file 'M' and 'm/a.json' as a case-sensitive disk keeps them; 'M' is kept on disk as 'UPPER_M'. */
function fileBesideFolder(cache: boolean) {
  setBackendKind('file');
  setGuildViewCache(cache);
  const guildId = String(++guilds);
  const p = (...rel: string[]) => dataPath(guildId, ...rel);
  fs.mkdirSync(p('m'), { recursive: true });
  fs.writeFileSync(p('m', 'a.json'), '1');
  fs.writeFileSync(p('UPPER_M'), '{"keep":true}');
  const upper = p('M');
  const redirect = (x: unknown): unknown => {
    if (typeof x !== 'string') return x;
    const abs = path.resolve(x);
    if (abs === upper) return p('UPPER_M');
    if (abs.startsWith(upper + path.sep)) return p('UPPER_M') + abs.slice(upper.length);
    return x;
  };
  vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: string, options?: any) => {
    const list = real.readdirSync(redirect(dir), options);
    if (path.resolve(dir) !== p() || !options?.withFileTypes) return list;
    return list.map((e: fs.Dirent) => (e.name === 'UPPER_M' ? dirent('M', false) : e));
  }) as never);
  for (const fn of ['rmdirSync', 'unlinkSync', 'lstatSync', 'statSync', 'existsSync', 'readFileSync'] as const) {
    vi.spyOn(fs, fn).mockImplementation(((x: string, ...rest: unknown[]) => real[fn](redirect(x), ...rest)) as never);
  }
  return { guildId, p };
}

describe.each([true, false])("file route: the file 'M' beside 'm/a.json' (cache %s)", cache => {
  it("a new 'm/x.json' is saved and lands, and 'M' keeps its bytes", async () => {
    const r = fileBesideFolder(cache);
    expect(dm.saveDataTracked('x.json', { guildId: r.guildId, category: 'm' }, 7).outcome).toBe('saved');
    await dm.flushAll();
    expect(real.readFileSync(r.p('m', 'x.json'), 'utf8')).toBe('7');
    expect(real.readFileSync(r.p('UPPER_M'), 'utf8')).toBe('{"keep":true}');
  });

  it("an overwrite of 'm/a.json' is saved", async () => {
    const r = fileBesideFolder(cache);
    expect(dm.saveDataTracked('a.json', { guildId: r.guildId, category: 'm' }, 8).outcome).toBe('saved');
    await dm.flushAll();
    expect(real.readFileSync(r.p('m', 'a.json'), 'utf8')).toBe('8');
  });

  it("a new 'M/y.json' is still refused, naming the file M", async () => {
    const r = fileBesideFolder(cache);
    expect(dm.saveDataTracked('y.json', { guildId: r.guildId, category: 'M' }, 9)).toEqual({
      outcome: 'refused',
      cause: 'unstorable',
      reason: 'the folder M of it is a file',
    });
    await dm.flushAll();
    expect(real.readFileSync(r.p('UPPER_M'), 'utf8')).toBe('{"keep":true}');
  });
});

describe("working-set route: the key 'M' beside 'm/a.json'", () => {
  it("a new 'm/x.json' is saved and stored, 'M' keeps its bytes, and 'M/y.json' is refused", async () => {
    setBackendKind('postgres');
    const store = new ServerStore();
    const guildId = String(++guilds);
    store.docs.set(`${guildId}|/M`, '{"keep":true}');
    store.docs.set(`${guildId}|m/a.json`, '1');
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    expect(dm.saveDataTracked('x.json', { guildId, category: 'm' }, 7).outcome).toBe('saved');
    expect(dm.saveDataTracked('a.json', { guildId, category: 'm' }, 8).outcome).toBe('saved');
    expect(dm.saveDataTracked('y.json', { guildId, category: 'M' }, 9)).toEqual({
      outcome: 'refused',
      cause: 'unstorable',
      reason: 'the folder M of it is a file',
    });
    expect(await ws.flushGuildNow(guildId, 1000)).toBe('ok');
    expect([...store.docs.entries()].filter(([k]) => k.startsWith(`${guildId}|`)).sort()).toEqual([
      [`${guildId}|/M`, '{"keep":true}'],
      [`${guildId}|m/a.json`, '8'],
      [`${guildId}|m/x.json`, '7'],
    ]);
    ws.evict(guildId);
  });
});
