import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listSharedUnits, type PgSession, type SharedPlaces, type SharedUnit } from '../../src/bot/internalSetup/utils/dataMigration';
import { root, wipeRoot } from '../helpers/migrationRig';

const GLOBAL = path.join(root, 'global');
const MODS = path.join(root, 'mods');
const CFG = path.join(root, 'cfg', 'config.json');
const INSTALLED = path.join(GLOBAL, 'appstore', 'installed.json');

const places = (extra: Partial<SharedPlaces> = {}): SharedPlaces => ({ rootConfig: CFG, global: GLOBAL, modules: MODS, listed: 'installed', ...extra });

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const names = (units: SharedUnit[]) => units.map(u => (u.kind === 'module' ? `module:${u.module}` : `${u.kind}:${u.key}`));

async function list(p: SharedPlaces = places()): Promise<{ units: string[]; leftOut: string[] }> {
  const leftOut: string[] = [];
  const units = names(await listSharedUnits(p, leftOut));
  return { units, leftOut };
}

async function refusalOf(p: SharedPlaces = places()): Promise<string> {
  try {
    await listSharedUnits(p, []);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the listing answered without a refusal');
}

const ODD = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false };

function oddEntryAt(target: string): void {
  const real = fs.promises.lstat.bind(fs.promises);
  vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    if (path.resolve(String(p)) === path.resolve(target)) return ODD as unknown as fs.Stats;
    return (real as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest);
  }) as typeof fs.promises.lstat);
}

beforeEach(() => {
  wipeRoot();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the files under /data/global', () => {
  it('leaves out an empty folder and a .tmp file, and keeps a folder whose subfolder and file are both listed', async () => {
    fs.mkdirSync(path.join(GLOBAL, 'empty'), { recursive: true });
    write(path.join(GLOBAL, 'half.tmp'), 'x');
    write(path.join(GLOBAL, 'a', 'b', 'one.json'), '{}');
    write(path.join(GLOBAL, 'a', 'two.json'), '{}');
    const { units, leftOut } = await list();
    expect(units).toEqual(['doc:global/a/b/one.json', 'doc:global/a/two.json']);
    expect(leftOut.map(f => path.resolve(f)).sort()).toEqual([path.join(GLOBAL, 'empty'), path.join(GLOBAL, 'half.tmp')].map(f => path.resolve(f)).sort());
  });

  it('refuses a global place that is a regular file', async () => {
    write(GLOBAL, 'not a folder');
    expect(await refusalOf()).toBe(`${GLOBAL} is a link or another entry that is not a folder, so its data cannot be copied exactly`);
  });

  it('refuses a global place that is neither a link, a file nor a folder', async () => {
    fs.mkdirSync(GLOBAL, { recursive: true });
    oddEntryAt(GLOBAL);
    expect(await refusalOf()).toBe(`${GLOBAL} is a link or another entry that is not a folder, so its data cannot be copied exactly`);
  });

  it('lists the payment provider credentials file when the places name no credentials mode', async () => {
    write(path.join(GLOBAL, 'payment-providers', 'credentials.json'), '{}');
    expect((await list()).units).toEqual(['doc:global/payment-providers/credentials.json']);
  });
});

describe('the root config', () => {
  it('leaves out a root config that is a folder', async () => {
    fs.mkdirSync(CFG, { recursive: true });
    const { units, leftOut } = await list();
    expect(units).toEqual([]);
    expect(leftOut).toEqual([CFG]);
  });

  it('refuses a root config that is neither a regular file nor a folder', async () => {
    write(CFG, '{}');
    oddEntryAt(CFG);
    expect(await refusalOf()).toBe(`${CFG} is neither a regular file nor a folder`);
  });
});

describe('the module folders', () => {
  it('lists every folder of a staging, which has no installed.json', async () => {
    fs.mkdirSync(path.join(MODS, 'm1'), { recursive: true });
    expect((await list(places({ listed: 'all' }))).units).toEqual(['module:m1']);
  });

  it('lists no module when installed.json holds null', async () => {
    write(INSTALLED, 'null');
    expect((await list()).units).toEqual(['doc:global/appstore/installed.json']);
  });

  it('names the file and the parse error when installed.json is not JSON', async () => {
    write(INSTALLED, '{not json');
    const text = await refusalOf();
    expect(text.startsWith(`${INSTALLED} cannot be read: `)).toBe(true);
    expect(text.length).toBeGreaterThan(`${INSTALLED} cannot be read: `.length);
    expect(text).not.toContain('no list of modules');
  });

  it('names an unreadable installed.json once', async () => {
    fs.mkdirSync(INSTALLED, { recursive: true });
    const text = await refusalOf();
    expect(text.startsWith(`${INSTALLED} cannot be read: `)).toBe(true);
    expect(text.split('cannot be read').length).toBe(2);
  });

  it('refuses an installed.json whose modules are a string', async () => {
    write(INSTALLED, JSON.stringify({ modules: 'abc' }));
    expect(await refusalOf()).toBe(`${INSTALLED} cannot be read: it holds no list of modules`);
  });

  it('refuses an installed.json whose modules are an array', async () => {
    write(INSTALLED, JSON.stringify({ modules: [] }));
    expect(await refusalOf()).toBe(`${INSTALLED} cannot be read: it holds no list of modules`);
  });

  it('leaves out a module named with a slash, one whose name a key refuses and one with no folder, in name order', async () => {
    write(INSTALLED, JSON.stringify({ modules: { zeta: { version: '2' }, 'a/b': {}, 'x.tmp': {}, gone: {}, alpha: { version: '1' } } }));
    for (const m of ['zeta', path.join('a', 'b'), 'x.tmp', 'alpha']) fs.mkdirSync(path.join(MODS, m), { recursive: true });
    const leftOut: string[] = [];
    const units = await listSharedUnits(places(), leftOut);
    expect(names(units)).toEqual(['doc:global/appstore/installed.json', 'module:alpha', 'module:zeta']);
    expect(units.filter(u => u.kind === 'module').map(u => (u as { version?: string | null }).version)).toEqual(['1', '2']);
    expect(leftOut).toEqual([path.join(MODS, 'a/b'), path.join(MODS, 'x.tmp'), path.join(MODS, 'gone')]);
  });

  it('refuses a listed module whose place is a regular file', async () => {
    write(INSTALLED, JSON.stringify({ modules: { m1: {} } }));
    write(path.join(MODS, 'm1'), 'file');
    const dir = path.join(MODS, 'm1');
    expect(await refusalOf()).toBe(`${dir} is a link or another entry that is not a folder, so its data cannot be copied exactly`);
  });
});

function sessionWith(docs: string[], lines: string[] = []): PgSession {
  return {
    async query(text: string) {
      if (text.includes('shared_docs')) return { rows: docs.map(key => ({ key })) };
      if (text.includes('shared_lines')) return { rows: lines.map(key => ({ key })) };
      if (text.includes('shared_modules')) return { rows: [] };
      throw new Error(`unexpected query ${text}`);
    },
    async end() {},
  };
}

async function pgRefusal(session: PgSession): Promise<string> {
  try {
    await listSharedUnits(session, []);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the listing answered without a refusal');
}

describe("the database's shared keys", () => {
  it('lists the root config doc and a global doc', async () => {
    expect(names(await listSharedUnits(sessionWith(['config.json', 'global/a.json']), []))).toEqual(['doc:config.json', 'doc:global/a.json']);
  });

  it('refuses the root config kept as a stream', async () => {
    expect(await pgRefusal(sessionWith([], ['config.json'])))
      .toBe("The key config.json of the database's shared files: an appended file must end in .jsonl; nothing was written");
  });

  it('refuses a key outside global/', async () => {
    expect(await pgRefusal(sessionWith(['other/x.json'])))
      .toBe("The key other/x.json of the database's shared files: it names no file of the data of no guild; nothing was written");
  });

  it('refuses a key of a file each machine keeps for itself', async () => {
    expect(await pgRefusal(sessionWith(['global/fleet/x.json'])))
      .toBe("The key global/fleet/x.json of the database's shared files: it names a file each machine keeps for itself; nothing was written");
  });
});
