import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials } from '../../src/utils/envLoader';
import { flushAll, setGuildWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import {
  insertValues, listSharedUnits, readSharedUnit,
  type PgSession, type ServiceOptions, type SharedPlaces, type SharedUnit,
} from '../../src/bot/internalSetup/utils/dataMigration';
import { setBackendKind } from '../helpers/backendKind';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

const WHERE = "the database's shared files";
const GLOBAL = path.join(root, 'global');
const MODS = path.join(root, 'srcmods');
const CFG = path.join(root, 'cfg', 'config.json');

beforeEach(async () => {
  await flushAll();
  wipeRoot();
  setBackendKind(null);
  setGuildWriteGate(null);
  _resetRowQueue();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  delete process.env.FLEET_SHARD_COUNT;
  loadCredentials();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setBackendKind(null);
  setGuildWriteGate(null);
  _resetRowQueue();
  delete process.env.DATA_BACKEND;
});

interface Rows {
  docs?: string[];
  lines?: string[];
  modules?: Array<Record<string, unknown>>;
  bodies?: Record<string, Buffer>;
  files?: Record<string, Array<{ rel: string; mode: number; bytes: Buffer }>>;
}

function pgOf(t: Rows): PgSession {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql === 'SELECT key FROM smdb_data.shared_docs') return { rows: (t.docs ?? []).map(key => ({ key })) };
      if (sql === 'SELECT DISTINCT key FROM smdb_data.shared_lines') return { rows: (t.lines ?? []).map(key => ({ key })) };
      if (sql === 'SELECT module, version FROM smdb_data.shared_modules') return { rows: t.modules ?? [] };
      if (sql === 'SELECT body FROM smdb_data.shared_docs WHERE key = $1') {
        const body = t.bodies?.[String(params![0])];
        return { rows: body ? [{ body }] : [] };
      }
      if (sql === 'SELECT rel, mode, bytes FROM smdb_data.shared_module_files WHERE module = $1 ORDER BY rel') {
        return { rows: t.files?.[String(params![0])] ?? [] };
      }
      throw new Error(`unexpected statement ${sql}`);
    },
    end: async () => undefined,
  };
}

const names = (units: SharedUnit[]) => units.map(u => (u.kind === 'module' ? `module:${u.module}` : `${u.kind}:${u.key}`));

async function refusalOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return (error as Error).message;
  }
  return 'no refusal';
}

const listRefusal = (t: Rows) => refusalOf(() => listSharedUnits(pgOf(t), []));

describe('ra49: the keys of the database shared files are checked before anything is written', () => {
  it('refuses a doc key whose part ends in .tmp with the key rule text', async () => {
    expect(await listRefusal({ docs: ['global/m/a.tmp'] }))
      .toBe(`The key global/m/a.tmp of ${WHERE}: the part "a.tmp" ends in ".tmp", which marks an interrupted write; nothing was written`);
  });

  it('refuses a key that names a file each machine keeps for itself', async () => {
    expect(await listRefusal({ docs: ['global/fleet/x.json'] }))
      .toBe(`The key global/fleet/x.json of ${WHERE}: it names a file each machine keeps for itself; nothing was written`);
  });

  it('refuses a key outside global/', async () => {
    expect(await listRefusal({ docs: ['other/x.json'] }))
      .toBe(`The key other/x.json of ${WHERE}: it names no file of the data of no guild; nothing was written`);
  });

  it('checks the keys in key order, so the first bad key named is the first in order', async () => {
    expect(await listRefusal({ docs: ['global/b.tmp', 'global/a.tmp'] }))
      .toBe(`The key global/a.tmp of ${WHERE}: the part "a.tmp" ends in ".tmp", which marks an interrupted write; nothing was written`);
  });

  it('refuses a key that is both a document and a stream', async () => {
    expect(await listRefusal({ docs: ['global/m/a.json'], lines: ['global/m/a.json'] }))
      .toBe(`The key global/m/a.json of ${WHERE} is both a document and a stream; nothing was written`);
  });

  it('refuses a key whose folder is a file, naming the folder below global/', async () => {
    expect(await listRefusal({ docs: ['global/m/a.json/b.json', 'global/m/a.json'] }))
      .toBe(`The key global/m/a.json/b.json of ${WHERE}: the folder m/a.json of it is a file; nothing was written`);
  });

  it('keeps the root config out of the key tree, so global/json/ beside config.json lists both', async () => {
    expect(names(await listSharedUnits(pgOf({ docs: ['global/json/x.json', 'config.json'] }), [])))
      .toEqual(['doc:config.json', 'doc:global/json/x.json']);
  });

  it('refuses a module name with a slash', async () => {
    expect(await listRefusal({ modules: [{ module: 'a/b', version: null }] }))
      .toBe(`The key a/b of ${WHERE}: a module is named by one folder name; nothing was written`);
  });

  it('lists each module with its version as text, null when the row has none', async () => {
    const units = await listSharedUnits(pgOf({
      modules: [{ module: 'm1', version: '1.2.0' }, { module: 'm2', version: null }, { module: 'm3' }, { module: 'm4', version: 3 }],
    }), []);
    expect(units).toEqual([
      { kind: 'module', module: 'm1', version: '1.2.0' },
      { kind: 'module', module: 'm2', version: null },
      { kind: 'module', module: 'm3', version: null },
      { kind: 'module', module: 'm4', version: '3' },
    ]);
  });
});

describe('ra49: a shared unit read from the database', () => {
  it('refuses a listed doc whose read finds no rows', async () => {
    expect(await refusalOf(() => readSharedUnit({ kind: 'doc', key: 'global/m/a.json' }, pgOf({}))))
      .toBe('The database lists global/m/a.json, but its read found no rows');
  });

  it('refuses a module file whose path breaks the key rule', async () => {
    const files = { mod1: [{ rel: 'a?.js', mode: 0o644, bytes: Buffer.from('x') }] };
    expect(await refusalOf(() => readSharedUnit({ kind: 'module', module: 'mod1', version: null }, pgOf({ files }))))
      .toBe(`The key mod1/a?.js of ${WHERE}: the part "a?.js" holds "?", which a Windows file name cannot hold; nothing was written`);
  });

  it('answers the module files in path order whatever order the rows come in', async () => {
    const files = { mod1: [{ rel: 'b.js', mode: 0o644, bytes: Buffer.from('b') }, { rel: 'a.js', mode: 0o600, bytes: Buffer.from('a') }] };
    const part = await readSharedUnit({ kind: 'module', module: 'mod1', version: '2.0' }, pgOf({ files }));
    expect(part.kind === 'module' && part.files.map(f => [f.rel, f.bytes.toString(), f.mode])).toEqual([['a.js', 'a', 0o600], ['b.js', 'b', 0o644]]);
  });
});

const jsonPlaces = (): SharedPlaces => ({ rootConfig: CFG, global: GLOBAL, modules: MODS, listed: 'all' });

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('ra49: a shared unit read from a JSON tree', () => {
  it('reads a stream whose first line is empty as two lines', async () => {
    const file = path.join(GLOBAL, 'm', 's.jsonl');
    write(file, '\nb\n');
    const part = await readSharedUnit({ kind: 'lines', key: 'global/m/s.jsonl', full: file }, jsonPlaces());
    expect(part.kind === 'lines' && part.lines.map(l => l.toString())).toEqual(['', 'b']);
  });

  it('answers the module files in path order whatever order the folder lists them in', async () => {
    const dir = path.join(MODS, 'mod1');
    write(path.join(dir, 'a.js'), 'a');
    write(path.join(dir, 'B.js'), 'B');
    write(path.join(dir, 'c.js'), 'c');
    const real = fs.promises.readdir.bind(fs.promises) as (...a: unknown[]) => Promise<Buffer[]>;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      const out = await real(p, ...rest);
      if (path.resolve(String(p)) !== path.resolve(dir)) return out;
      return [...out].sort((x, y) => (x.toString() < y.toString() ? 1 : -1));
    }) as unknown as typeof fs.promises.readdir);
    const part = await readSharedUnit({ kind: 'module', module: 'mod1', dir, version: '1.0' }, jsonPlaces());
    expect(part.kind === 'module' && part.files.map(f => f.rel)).toEqual(['B.js', 'a.js', 'c.js']);
  });

  it('refuses a module file whose name part is longer than a key part may be', async () => {
    const dir = path.join(MODS, 'mod1');
    const name = `${String.fromCharCode(0xe9).repeat(100)}.js`;
    const full = path.join(dir, name);
    write(full, 'x');
    const refusal = `the part "${name.slice(0, 40)}..." is 203 bytes; one part of a key holds at most 200`;
    expect(await refusalOf(() => readSharedUnit({ kind: 'module', module: 'mod1', dir, version: null }, jsonPlaces())))
      .toBe(`The key mod1/${name} of ${full}: ${refusal}; nothing was written`);
  });
});

async function runToPg(db: FakeDb, jobId: string) {
  const extra: ServiceOptions = { rootConfigPath: CFG, sourceModulesDir: MODS };
  const service = serviceFor(db, new FakeHost(), extra);
  await service.post({ jobId, to: 'postgres' });
  await service.idle();
  return service.status().body.job;
}

describe('ra49: the shared streams of a move to Postgres', () => {
  it('leaves out an empty stream and copies no line of it', async () => {
    freshJsonBot();
    seedFile('global/m/a.json', '{"a":1}');
    seedFile('global/m/empty.jsonl', '');
    const db = new FakeDb();
    const job = await runToPg(db, 'job-ra49-empty-01');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect((job.leftOut as string[]).map(f => path.resolve(f))).toContain(path.resolve(path.join(GLOBAL, 'm', 'empty.jsonl')));
    const session = db.connect('ra49-read') as unknown as PgSession;
    expect((await session.query('SELECT DISTINCT key FROM smdb_data.shared_lines')).rows).toEqual([]);
  });

  it('names no closed tail for a stream that ends in a newline', async () => {
    freshJsonBot();
    seedFile('global/m/log.jsonl', '{"e":1}\n{"e":2}\n');
    const warn = console.warn as unknown as { mock: { calls: unknown[][] } };
    const db = new FakeDb();
    const job = await runToPg(db, 'job-ra49-tail-01');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(job.closedTails ?? []).toEqual([]);
    expect(warn.mock.calls.some(c => String(c[0]).includes('did not end in a newline'))).toBe(false);
  });
});

function recorder(limit = 20): { session: PgSession; sent: Array<{ sql: string; params: unknown[] }> } {
  const sent: Array<{ sql: string; params: unknown[] }> = [];
  const session: PgSession = {
    query: async (sql, params) => {
      if (sent.length >= limit) throw new Error('too many statements');
      sent.push({ sql, params: params ?? [] });
      return { rows: [] };
    },
    end: async () => undefined,
  };
  return { session, sent };
}

describe('ra49: insertValues batches', () => {
  it('sends at most 500 rows in one statement', async () => {
    const { session, sent } = recorder();
    const rows = Array.from({ length: 501 }, (_, i) => [`r${i}`]);
    await insertValues(session, 'INSERT INTO t (a)', ['$'], rows);
    expect(sent.map(s => s.params.length)).toEqual([500, 1]);
    expect(sent[1]).toEqual({ sql: 'INSERT INTO t (a) VALUES ($1)', params: ['r500'] });
    expect(sent.flatMap(s => s.params)).toEqual(rows.flat());
  });

  it('keeps small rows in one statement under the byte bound', async () => {
    const { session, sent } = recorder();
    await insertValues(session, 'INSERT INTO t (a, b)', ['$', '$'], [['x', 'y'], ['z', 'w']]);
    expect(sent).toEqual([{ sql: 'INSERT INTO t (a, b) VALUES ($1, $2), ($3, $4)', params: ['x', 'y', 'z', 'w'] }]);
  });

  it('fills a statement up to exactly the byte bound and starts the next past it', async () => {
    const { session, sent } = recorder();
    await insertValues(session, 'INSERT INTO t (a)', ['$'], [['ab'], ['cd'], ['e']], 4);
    expect(sent).toEqual([
      { sql: 'INSERT INTO t (a) VALUES ($1), ($2)', params: ['ab', 'cd'] },
      { sql: 'INSERT INTO t (a) VALUES ($1)', params: ['e'] },
    ]);
  });
});
