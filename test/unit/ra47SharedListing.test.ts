import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertValues, listSharedUnits, type PgSession, type SharedPlaces } from '../../src/bot/internalSetup/utils/dataMigration';

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tree(): { base: string; places: SharedPlaces } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ra47-'));
  temps.push(base);
  const global = path.join(base, 'global');
  fs.mkdirSync(global, { recursive: true });
  return { base, places: { rootConfig: path.join(base, 'config.json'), global, modules: path.join(base, 'modules'), listed: 'all' } };
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function refusalOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the listing was not refused');
}

function pgSession(answers: { docs?: string[]; lines?: string[]; modules?: Array<{ module: string; version: string | null }> }): PgSession {
  return {
    query: async (sql: string) => {
      if (sql === 'SELECT key FROM smdb_data.shared_docs') return { rows: (answers.docs ?? []).map(key => ({ key })) };
      if (sql === 'SELECT DISTINCT key FROM smdb_data.shared_lines') return { rows: (answers.lines ?? []).map(key => ({ key })) };
      if (sql === 'SELECT module, version FROM smdb_data.shared_modules') return { rows: answers.modules ?? [] };
      throw new Error(`unexpected statement ${sql}`);
    },
    end: async () => undefined,
  } as PgSession;
}

describe('ra47: the database shared units come in key order, then modules in name order', () => {
  it('sorts docs and modules given out of order and keeps two rows of one module in the order read', async () => {
    const session = pgSession({
      docs: ['global/m/c.json', 'global/m/a.json', 'global/m/b.json'],
      modules: [{ module: 'zeta', version: '1' }, { module: 'alpha', version: '1' }, { module: 'dup', version: '1' }, { module: 'mid', version: '1' }, { module: 'dup', version: '2' }],
    });
    const units = await listSharedUnits(session, []);
    expect(units).toEqual([
      { kind: 'doc', key: 'global/m/a.json' },
      { kind: 'doc', key: 'global/m/b.json' },
      { kind: 'doc', key: 'global/m/c.json' },
      { kind: 'module', module: 'alpha', version: '1' },
      { kind: 'module', module: 'dup', version: '1' },
      { kind: 'module', module: 'dup', version: '2' },
      { kind: 'module', module: 'mid', version: '1' },
      { kind: 'module', module: 'zeta', version: '1' },
    ]);
  });

  it("names the database's shared files when a key is both a document and a stream", async () => {
    const session = pgSession({ docs: ['global/m/a.json'], lines: ['global/m/a.json'] });
    expect(await refusalOf(listSharedUnits(session, [])))
      .toBe("The key global/m/a.json of the database's shared files is both a document and a stream; nothing was written");
  });
});

describe('ra47: insertValues counts a null or absent value as no bytes', () => {
  it('sends rows whose text fills the batch exactly in one statement', async () => {
    const sent: unknown[][] = [];
    const session = { query: async (_sql: string, params?: unknown[]) => { sent.push(params ?? []); return { rows: [] }; }, end: async () => undefined } as PgSession;
    await insertValues(session, 'INSERT INTO t (a, b)', ['$', '$'], [['ab', null], ['cd', undefined]], 4);
    expect(sent).toEqual([['ab', null, 'cd', undefined]]);
  });
});

describe('ra47: a JSON tree whose folders or names cannot be read is refused', () => {
  it('refuses a module place that is a file, naming the folder', async () => {
    const { places } = tree();
    write(places.modules, 'not a folder');
    const text = await refusalOf(listSharedUnits(places, []));
    expect(text.startsWith(`The folder ${places.modules} cannot be read: `)).toBe(true);
    expect(text.length).toBeGreaterThan(`The folder ${places.modules} cannot be read: `.length);
  });

  it('refuses a file name that is not valid UTF-8', async () => {
    const { places } = tree();
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (dir: fs.PathLike, opts?: unknown) => {
      if (String(dir) === places.global) return [Buffer.from([0x61, 0xff, 0x62])];
      return readdir(dir, opts as any);
    }) as any);
    expect(await refusalOf(listSharedUnits(places, []))).toBe(`A file name under ${places.global} is not valid UTF-8`);
  });

  it('refuses a root config whose lstat fails with an error other than a missing file', async () => {
    const { places } = tree();
    write(places.rootConfig, '{}');
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: fs.PathLike, opts?: unknown) => {
      if (String(p) === places.rootConfig) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return lstat(p, opts as any);
    }) as any);
    expect(await refusalOf(listSharedUnits(places, []))).toBe(`${places.rootConfig} cannot be read: EACCES: permission denied`);
  });

  it('refuses a root config whose lstat fails with no error value', async () => {
    const { places } = tree();
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: fs.PathLike, opts?: unknown) => {
      if (String(p) === places.rootConfig) return Promise.reject(undefined);
      return lstat(p, opts as any);
    }) as any);
    expect(await refusalOf(listSharedUnits(places, []))).toBe(`${places.rootConfig} cannot be read: undefined`);
  });
});

describe('ra47: the global folder walk', () => {
  it('refuses an entry that is neither a regular file nor a folder', async () => {
    const { places } = tree();
    const odd = path.join(places.global, 'm', 'pipe.json');
    write(odd, '{}');
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: fs.PathLike, opts?: unknown) => {
      const st = await lstat(p, opts as any);
      if (String(p) !== odd) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false });
    }) as any);
    expect(await refusalOf(listSharedUnits(places, []))).toBe(`${odd} is neither a regular file nor a folder`);
  });

  it('leaves out an empty folder and lists the files of a full one', async () => {
    const { places } = tree();
    write(path.join(places.global, 'm', 'a.json'), '{"a":1}');
    fs.mkdirSync(path.join(places.global, 'empty'));
    const leftOut: string[] = [];
    const units = await listSharedUnits(places, leftOut);
    expect(units).toEqual([{ kind: 'doc', key: 'global/m/a.json', full: path.join(places.global, 'm', 'a.json') }]);
    expect(leftOut).toEqual([path.join(places.global, 'empty')]);
  });
});
