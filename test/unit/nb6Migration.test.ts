import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';
import { appendDataTracked, flushAll, saveDataTracked, setGuildWriteGate, writeRawAtomic } from '../../src/bot/internalSetup/utils/dataManager';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { _resetRowQueue, mirrorPathOf, shaOf } from '../../src/bot/internalSetup/utils/sharedStore';
import { moduleShaOf } from '../../src/bot/internalSetup/utils/sharedModules';
import { BotManager } from '../../src/webui/botManager';
import type { ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { failFlushes } from '../helpers/configRig';
import { setBackendKind } from '../helpers/backendKind';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, STORES, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why, writeJson } from '../helpers/migrationRig';

// NB6 test 17: the data of no guild in NB3's job, rows 68 to 73 and 117, cells 433 to 435 and the lock lists, against
// FakeDb and temp folders. The root config and the source modules dir are temp paths under DATA_DIR.

const G1 = '880000000000000001';
const CFG = path.join(root, 'cfg', 'config.json');
const MODS = path.join(root, 'srcmods');
const BIN = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a, 0xc3]);
const NUL = Buffer.from('{"a":"\u0000"}', 'utf8');
const NODE_BIN = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const INSTALLED = { modules: { mod1: { name: 'mod1', version: '1.2.0', installedFrom: 'repo', installedAt: '2026-11-01T00:00:00.000Z' } } };

const opts = (extra: ServiceOptions = {}): ServiceOptions => ({ rootConfigPath: CFG, sourceModulesDir: MODS, ...extra });

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

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A JSON bot with a guild, the root config, global docs (one not UTF-8, one holding U+0000), a stream, a module and the locals. */
function seedJsonSource(): void {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"g":1}');
  write(CFG, '{"prefix":"!"}');
  seedFile('global/m/a.json', '{"a":1}');
  seedFile('global/m/bin.dat', BIN);
  seedFile('global/m/zero.json', NUL);
  seedFile('global/m/log.jsonl', '{"e":1}\n{"e":2}');
  seedFile('global/appstore/installed.json', JSON.stringify(INSTALLED));
  write(path.join(MODS, 'mod1', 'module.json'), '{"name":"mod1","version":"1.2.0"}');
  write(path.join(MODS, 'mod1', 'lib', 'bin.node'), NODE_BIN);
  write(path.join(MODS, 'other', 'index.js'), 'module.exports = 1;');
  seedFile('global/fleet/node.json', '{"node":"local"}');
  seedFile('global/appstore/cache/repo/x.txt', 'clone');
  seedFile('global/metrics/totals.json', '{"n":3}');
}

const modFiles = () => [
  { rel: 'lib/bin.node', bytes: NODE_BIN },
  { rel: 'module.json', bytes: Buffer.from('{"name":"mod1","version":"1.2.0"}') },
];

const SHARED_BYTES = Buffer.byteLength('{"prefix":"!"}') + Buffer.byteLength(JSON.stringify(INSTALLED)) + Buffer.byteLength('{"a":1}')
  + BIN.length + NUL.length + Buffer.byteLength('{"e":1}') + Buffer.byteLength('{"e":2}') + NODE_BIN.length + Buffer.byteLength('{"name":"mod1","version":"1.2.0"}');

async function run(db: FakeDb, jobId: string, to: 'postgres' | 'file', host = new FakeHost(), extra: ServiceOptions = {}) {
  const service = serviceFor(db, host, opts(extra));
  const answer = await service.post({ jobId, to });
  await service.idle();
  return { answer, job: service.status().body.job };
}

const body = (row: Record<string, any>) => Buffer.from(row.body);

describe('row 68: a move to Postgres copies the data of no guild in the copy transaction', () => {
  it('writes every shared doc, line, module and module file, counts them and leaves the locals and the unlisted folder out', async () => {
    seedJsonSource();
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6m-68-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const store = db.schemas.get('smdb_data')!;
    const docs = [...store.docs!].sort((a, b) => (a.key < b.key ? -1 : 1));
    expect(docs.map(d => d.key)).toEqual(['config.json', 'global/appstore/installed.json', 'global/m/a.json', 'global/m/bin.dat', 'global/m/zero.json']);
    const expected: Record<string, Buffer> = {
      'config.json': Buffer.from('{"prefix":"!"}'), 'global/appstore/installed.json': Buffer.from(JSON.stringify(INSTALLED)),
      'global/m/a.json': Buffer.from('{"a":1}'), 'global/m/bin.dat': BIN, 'global/m/zero.json': NUL,
    };
    for (const d of docs) {
      expect(body(d).equals(expected[d.key]), d.key).toBe(true);
      expect(d.sha).toBe(shaOf(expected[d.key]));
      expect(d.updated_by).toBe('migration/job-nb6m-68-01');
    }
    expect(new Set(docs.map(d => d.rev)).size).toBe(5);
    const lines = [...store.lines!].sort((a, b) => a.seq - b.seq);
    expect(lines.map(l => [l.key, Buffer.from(l.line).toString('utf8')])).toEqual([['global/m/log.jsonl', '{"e":1}'], ['global/m/log.jsonl', '{"e":2}']]);
    expect(new Set(lines.map(l => l.id)).size).toBe(2);
    for (const l of lines) expect(l.id).toMatch(/^[0-9a-f-]{36}$/);
    const fileShas = modFiles().map(f => ({ rel: f.rel, sha: shaOf(f.bytes) }));
    expect(store.modules!.map(m => ({ module: m.module, sha: m.sha, version: m.version, file_count: m.file_count, bytes: Number(m.bytes), updated_by: m.updated_by })))
      .toEqual([{ module: 'mod1', sha: moduleShaOf(fileShas), version: '1.2.0', file_count: 2, bytes: NODE_BIN.length + 33, updated_by: 'migration/job-nb6m-68-01' }]);
    const files = [...store.moduleFiles!].sort((a, b) => (a.rel < b.rel ? -1 : 1));
    expect(files.map(f => [f.module, f.rel])).toEqual([['mod1', 'lib/bin.node'], ['mod1', 'module.json']]);
    expect(Buffer.from(files[0].bytes).equals(NODE_BIN)).toBe(true);
    expect(typeof files[0].mode).toBe('number');
    expect(job.counts).toEqual({
      documents: 1, appendFiles: 0, graveyardEntries: 0, bytes: 7,
      sharedDocs: 5, sharedLines: 2, modules: 1, moduleFiles: 2, sharedBytes: SHARED_BYTES, providerKeys: 0,
    });
    expect(job.closedTails).toEqual(['global/m/log.jsonl']);
    expect(readJson(JOURNAL).counts).toEqual(job.counts);
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
    // The source stays where it is, byte for byte.
    expect(fs.readFileSync(dataPath('global', 'm', 'bin.dat')).equals(BIN)).toBe(true);
    expect(fs.readFileSync(dataPath('global', 'm', 'log.jsonl'), 'utf8')).toBe('{"e":1}\n{"e":2}');
  });

  it('sends the shared rows after the guild rows, inside the copy transaction, then reads them back and reads the source again', async () => {
    seedJsonSource();
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6m-68-02', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const sql = db.statements('smdb-migrate:job-nb6m-68-02');
    const at = (re: RegExp) => sql.findIndex(s => re.test(s));
    const begin = sql.indexOf('BEGIN');
    const commit = sql.lastIndexOf('COMMIT');
    const guild = at(/^INSERT INTO smdb_data\.guild_data /);
    const docs = at(/^INSERT INTO smdb_data\.shared_docs/);
    const lines = at(/^INSERT INTO smdb_data\.shared_lines/);
    const mods = at(/^INSERT INTO smdb_data\.shared_modules/);
    const files = at(/^INSERT INTO smdb_data\.shared_module_files/);
    const readBack = at(/encode\(sha256\(body\), 'hex'\)/);
    expect(begin).toBeGreaterThanOrEqual(0);
    for (const i of [guild, docs, lines, mods, files, readBack]) {
      expect(i).toBeGreaterThan(begin);
      expect(i).toBeLessThan(commit);
    }
    expect(docs).toBeGreaterThan(guild);
    expect(readBack).toBeGreaterThan(Math.max(docs, lines, mods, files));
  });
});

describe('row 69: a shared file that cannot be read', () => {
  it('fails the job at reading, naming the path, with nothing written', async () => {
    seedJsonSource();
    const target = dataPath('global', 'm', 'a.json');
    const real = fs.promises.readFile;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(((p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(target)) return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
      return (real as any)(p, ...rest);
    }) as typeof fs.promises.readFile);
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6m-69-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job.error).toBe(`${target} cannot be read: EACCES: permission denied`);
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });
});

describe('a shared file whose key rule K refuses (decision 18), as NB3 refuses a guild key', () => {
  it('fails the job at reading, naming the key and the path, with nothing written', async () => {
    seedJsonSource();
    const name = `${'k'.repeat(201)}.json`;
    seedFile(`global/m/${name}`, '{}');
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6m-69-02', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job.error).toBe(`The key global/m/${name} of ${dataPath('global', 'm', name)}: the part "${'k'.repeat(40)}..." is 206 bytes; one part of a key holds at most 200; nothing was written`);
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});

describe('row 70: a read-back or a re-read that differs rolls the copy back', () => {
  it('a shared doc changed between the read and the copy: decision 19\'s text for the shared files', async () => {
    seedJsonSource();
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6m-70-01', 'postgres', new FakeHost(), {
      fault: p => { if (p === 'S5') fs.writeFileSync(dataPath('global', 'm', 'a.json'), '{"a":2}'); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The shared files read back from the destination differ from the source (global/m/a.json: its bytes differ); nothing was switched');
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });

  it('a module file changed between the read and the copy: decision 19\'s text for the module files', async () => {
    seedJsonSource();
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6m-70-02', 'postgres', new FakeHost(), {
      fault: p => { if (p === 'S5') fs.writeFileSync(path.join(MODS, 'mod1', 'lib', 'bin.node'), 'changed'); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The module files read back from the destination differ from the source (mod1/lib/bin.node: its bytes differ); nothing was switched');
    expect(db.schemas.has('smdb_data')).toBe(false);
  });

  it('a shared line changed before the second read fails at rereading and rolls back', async () => {
    seedJsonSource();
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6m-70-03', 'postgres', new FakeHost(), {
      fault: p => { if (p === 'S7') fs.appendFileSync(dataPath('global', 'm', 'log.jsonl'), '\n{"e":3}\n'); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(job.error).toBe('The source read a second time differs from the source in 1 document(s): global/m/log.jsonl');
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});

/** The FakeDb store a real move to Postgres of seedJsonSource() wrote, with the marker and env it left. */
async function postgresSource(): Promise<FakeDb> {
  seedJsonSource();
  const db = new FakeDb();
  const { job } = await run(db, 'job-nb6m-src-01', 'postgres');
  expect(job, why(job)).toMatchObject({ state: 'done' });
  return db;
}

/** The superseded folder of a job. */
function supersededOf(jobId: string): string {
  const names = fs.readdirSync(path.join(root, '_superseded')).filter(n => n.endsWith(`-${jobId}`));
  expect(names).toHaveLength(1);
  return path.join(root, '_superseded', names[0]);
}

describe('row 71 and cells 433 and 434: a move to JSON places every shared item and moves the old mirrors aside', () => {
  it('places the root config, every global file byte for byte and the module folder; the locals stay; the old ones go to superseded', async () => {
    const db = await postgresSource();
    write(CFG, '{"prefix":"old"}');
    fs.writeFileSync(dataPath('global', 'm', 'a.json'), '{"a":"old"}');
    seedFile('global/m/extra.json', '{"x":1}');
    fs.writeFileSync(path.join(MODS, 'mod1', 'module.json'), '{"old":true}');
    const { job } = await run(db, 'job-nb6m-71-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(fs.readFileSync(CFG, 'utf8')).toBe('{"prefix":"!"}');
    expect(fs.readFileSync(dataPath('global', 'm', 'a.json'), 'utf8')).toBe('{"a":1}');
    expect(fs.readFileSync(dataPath('global', 'm', 'bin.dat')).equals(BIN)).toBe(true);
    expect(fs.readFileSync(dataPath('global', 'm', 'zero.json')).equals(NUL)).toBe(true);
    expect(fs.readFileSync(dataPath('global', 'm', 'log.jsonl'), 'utf8')).toBe('{"e":1}\n{"e":2}\n');
    expect(fs.existsSync(dataPath('global', 'm', 'extra.json'))).toBe(false);
    for (const f of modFiles()) expect(fs.readFileSync(path.join(MODS, 'mod1', ...f.rel.split('/'))).equals(f.bytes), f.rel).toBe(true);
    expect(fs.readFileSync(dataPath('global', 'fleet', 'node.json'), 'utf8')).toBe('{"node":"local"}');
    expect(fs.readFileSync(dataPath('global', 'appstore', 'cache', 'repo', 'x.txt'), 'utf8')).toBe('clone');
    expect(fs.readFileSync(dataPath('global', 'metrics', 'totals.json'), 'utf8')).toBe('{"n":3}');
    expect(fs.readFileSync(path.join(MODS, 'other', 'index.js'), 'utf8')).toBe('module.exports = 1;');
    const sup = supersededOf('job-nb6m-71-01');
    expect(fs.readFileSync(path.join(sup, 'config.json'), 'utf8')).toBe('{"prefix":"old"}');
    expect(fs.readFileSync(path.join(sup, 'global', 'm', 'a.json'), 'utf8')).toBe('{"a":"old"}');
    expect(fs.readFileSync(path.join(sup, 'global', 'm', 'extra.json'), 'utf8')).toBe('{"x":1}');
    expect(fs.readFileSync(path.join(sup, 'appstore-modules', 'mod1', 'module.json'), 'utf8')).toBe('{"old":true}');
    expect(fs.existsSync(path.join(sup, 'global', 'fleet'))).toBe(false);
    expect(job.counts).toEqual({
      documents: 1, appendFiles: 0, graveyardEntries: 0, bytes: 7,
      sharedDocs: 5, sharedLines: 2, modules: 1, moduleFiles: 2, sharedBytes: SHARED_BYTES, providerKeys: 0,
    });
    expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
  });
});

describe('row 72: a crash between two placements', () => {
  it('keeps the staged folder; the next run moves it aside and places every shared item', async () => {
    const db = await postgresSource();
    fs.writeFileSync(dataPath('global', 'm', 'a.json'), '{"a":"old"}');
    const real = fs.promises.rename;
    let placed = 0;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (String(from).includes(`${path.sep}.migrate-`) && path.resolve(String(to)).startsWith(path.resolve(dataPath('global')) + path.sep)) {
        placed += 1;
        if (placed === 2) throw Object.assign(new Error('the process died'), { simulateDeath: true });
      }
      return (real as any)(from, to);
    }) as typeof fs.promises.rename);
    const first = await run(db, 'job-nb6m-72-01', 'file');
    spy.mockRestore();
    expect(placed).toBe(2);
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-nb6m-72-01', stage: 'placing' });
    expect(readJson(JOURNAL).result).toBeUndefined();
    expect(first.job.state).toBe('interrupted');
    const staged = fs.readdirSync(root).filter(n => n.startsWith('.migrate-'));
    expect(staged).toHaveLength(1);
    expect(fs.readFileSync(path.join(supersededOf('job-nb6m-72-01'), 'global', 'm', 'a.json'), 'utf8')).toBe('{"a":"old"}');

    const second = await run(db, 'job-nb6m-72-02', 'file');
    expect(second.job, why(second.job)).toMatchObject({ state: 'done' });
    expect(fs.readFileSync(dataPath('global', 'm', 'a.json'), 'utf8')).toBe('{"a":1}');
    expect(fs.readFileSync(dataPath('global', 'm', 'bin.dat')).equals(BIN)).toBe(true);
    expect(fs.readFileSync(CFG, 'utf8')).toBe('{"prefix":"!"}');
    expect(fs.existsSync(path.join(supersededOf('job-nb6m-72-02'), staged[0]))).toBe(true);
    expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
  });
});

describe('row 73: a shared write during the job', () => {
  it('is refused with the migration refusal on a Postgres bot; one queued before is what the host waits for', async () => {
    freshJsonBot();
    setBackendKind('postgres');
    setGuildWriteGate(() => 'A data migration is running');
    expect(() => saveDataTracked('g.json', { scope: 'global', category: 'm' }, { g: 1 })).toThrow(DataBackendUnavailableError);
    expect(() => saveDataTracked('g.json', { scope: 'global', category: 'm' }, { g: 1 })).toThrow('A data migration is running; the write was not saved');
    expect(() => writeRawAtomic(mirrorPathOf('config.json'), '{}')).toThrow(DataBackendUnavailableError);
    expect(() => appendDataTracked('l.jsonl', { scope: 'global', category: 'm' }, 'x')).toThrow(DataBackendUnavailableError);
    setGuildWriteGate(null);
    expect(BotManager.prototype.sharedWritesSettled.call(undefined)).toBe(true);
    expect(saveDataTracked('g.json', { scope: 'global', category: 'm' }, { g: 1 }).outcome).toBe('saved');
    expect(BotManager.prototype.sharedWritesSettled.call(undefined)).toBe(false);
    _resetRowQueue();
    expect(BotManager.prototype.sharedWritesSettled.call(undefined)).toBe(true);
  });
});

describe('row 117: S3 waits for the web UI\'s shared writes', () => {
  it('refuses at draining when one is still being saved after the wait, with nothing written', async () => {
    seedJsonSource();
    const host = new FakeHost();
    host.sharedMark = true;
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6m-117-01', 'postgres', host, { sharedWaitMs: 300 });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'draining' });
    expect(job.error).toBe('A change to the shared files is still being saved; run the migration once it ends');
    expect(db.schemas.has('smdb_data')).toBe(false);
  });

  it('goes on once the writes settle within the wait', async () => {
    seedJsonSource();
    const host = new FakeHost();
    host.sharedMark = true;
    setTimeout(() => { host.sharedMark = false; }, 150);
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6m-117-02', 'postgres', host, { sharedWaitMs: 5000 });
    expect(job, why(job)).toMatchObject({ state: 'done' });
  });

  it('on a JSON source the drain waits for a queued global write too, and names one that cannot be written', async () => {
    seedJsonSource();
    const stuck = dataPath('global', 'm', 'stuck.json');
    const undo = failFlushes(stuck);
    try {
      saveDataTracked('stuck.json', { scope: 'global', category: 'm' }, { s: 1 });
      const db = new FakeDb();
      const { job } = await run(db, 'job-nb6m-117-03', 'postgres');
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'draining' });
      expect(job.error).toBe(`Writes of the web UI are still queued and could not be written: ${stuck}`);
      expect(db.schemas.has('smdb_data')).toBe(false);
    } finally {
      undo();
      await flushAll();
    }
  });
});

const SHARED_TABLES = 'smdb_data.shared_docs, smdb_data.shared_lines, smdb_data.shared_modules, smdb_data.shared_module_files, smdb_data.shared_ops';

describe('the lock lists name the shared tables', () => {
  it('a Postgres source takes its SHARE lock and its retirement lock on the shared tables too', async () => {
    const db = await postgresSource();
    const { job } = await run(db, 'job-nb6m-lock-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const sql = db.statements('smdb-migrate:job-nb6m-lock-01');
    const guild = 'smdb_data.guild_data, smdb_data.guild_append, smdb_data.guild_data_graveyard, smdb_data.guild_ownership';
    expect(sql).toContain(`LOCK TABLE ${guild}, ${SHARED_TABLES} IN SHARE MODE`);
    expect(sql).toContain(`LOCK TABLE ${guild}, ${SHARED_TABLES} IN ACCESS EXCLUSIVE MODE`);
  });

  it('a listed store renamed aside by a move to Postgres is locked with its shared tables', async () => {
    seedJsonSource();
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('old-store'));
    writeJson(STORES, { storeIds: ['old-store'] });
    writeJson(JOURNAL, { jobId: 'job-dest-earlier', to: 'postgres', stage: 'committing', startedAt: 1, storeId: 'old-store' });
    const { job } = await run(db, 'job-nb6m-lock-02', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const sql = db.statements('smdb-migrate:job-nb6m-lock-02');
    expect(sql).toContain(`LOCK TABLE smdb_data.meta, smdb_data.guild_ownership, smdb_data.guild_data, smdb_data.guild_append, smdb_data.guild_data_graveyard, ${SHARED_TABLES} IN ACCESS EXCLUSIVE MODE`);
  });

  it('a store of an earlier version, with no shared tables, is locked without them', async () => {
    seedJsonSource();
    const db = new FakeDb();
    db.schemas.set('smdb_data', { ...emptyStore('old-store'), noShared: true });
    writeJson(STORES, { storeIds: ['old-store'] });
    writeJson(JOURNAL, { jobId: 'job-dest-earlier', to: 'postgres', stage: 'committing', startedAt: 1, storeId: 'old-store' });
    const { job } = await run(db, 'job-nb6m-lock-03', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(db.statements('smdb-migrate:job-nb6m-lock-03'))
      .toContain('LOCK TABLE smdb_data.meta, smdb_data.guild_ownership, smdb_data.guild_data, smdb_data.guild_append, smdb_data.guild_data_graveyard IN ACCESS EXCLUSIVE MODE');
  });
});

describe('S2: a database this deployment never served', () => {
  it('holding shared rows and no guild rows is not called droppable', async () => {
    seedJsonSource();
    const db = new FakeDb();
    db.schemas.set('smdb_data', { ...emptyStore('foreign'), docs: [{ key: 'global/x.json', body: Buffer.from('{}'), sha: shaOf(Buffer.from('{}')), rev: 1, updated_by: 'x' }] });
    const { job } = await run(db, 'job-nb6m-s2-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe('The database already holds store foreign in schema smdb_data (0 documents, 0 streams, 0 graveyard rows, 0 ownership rows), which this deployment never served');
  });

  it('holding no rows at all is (guard)', async () => {
    seedJsonSource();
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('foreign'));
    const { job } = await run(db, 'job-nb6m-s2-02', 'postgres');
    expect(job.error).toMatch(/; the schema holds no guild rows, so it can be dropped$/);
  });
});

describe('cell 435: a 64 MiB module', () => {
  it('is read as one unit and copied in inserts of at most 16 MiB of values; the journal holds counts, not bytes', async () => {
    freshJsonBot();
    seedFile('global/appstore/installed.json', JSON.stringify({ modules: { big: { name: 'big', version: '1.0.0', installedFrom: 'r', installedAt: 't' } } }));
    const parts = Array.from({ length: 4 }, () => randomBytes(16 * 1024 * 1024));
    parts.forEach((b, i) => write(path.join(MODS, 'big', `part${i}.bin`), b));
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6m-435-01', 'postgres');
    expect(job, why({ ...job, counts: job?.counts })).toMatchObject({ state: 'done' });
    expect(job.counts).toMatchObject({ modules: 1, moduleFiles: 4 });
    expect(job.counts.sharedBytes).toBe(64 * 1024 * 1024 + Buffer.byteLength(JSON.stringify({ modules: { big: { name: 'big', version: '1.0.0', installedFrom: 'r', installedAt: 't' } } })));
    const inserts = db.paramBytes.filter(p => /^INSERT INTO smdb_data\.shared_module_files/.test(p.sql));
    expect(inserts.length).toBe(4);
    for (const p of inserts) expect(p.bytes).toBeLessThanOrEqual(16 * 1024 * 1024 + 64);
    const stored = db.schemas.get('smdb_data')!.moduleFiles!.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    stored.forEach((f, i) => expect(Buffer.from(f.bytes).equals(parts[i])).toBe(true));
    expect(fs.statSync(JOURNAL).size).toBeLessThan(4096);
  }, 120_000);
});
