import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials } from '../../src/utils/envLoader';
import { flushAll, setGuildWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { insertValues, type PgSession, type ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { setBackendKind } from '../helpers/backendKind';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

const G1 = '880000000000000050';
const CFG = path.join(root, 'cfg', 'config.json');
const MODS = path.join(root, 'srcmods');
const REV = "nextval('smdb_data.shared_rev_seq')";

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

function seedSource(): void {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"g":1}');
  write(CFG, '{"prefix":"!"}');
  seedFile('global/m/a.json', '{"a":1}');
  seedFile('global/m/log.jsonl', '{"e":1}\n{"e":2}\n');
  seedFile('global/appstore/installed.json', JSON.stringify({ modules: { mod1: { name: 'mod1', version: '1.2.0', installedFrom: 'repo', installedAt: '2026-11-01T00:00:00.000Z' } } }));
  write(path.join(MODS, 'mod1', 'module.json'), '{"name":"mod1","version":"1.2.0"}');
  write(path.join(MODS, 'mod1', 'lib', 'x.js'), 'module.exports = 2;');
}

type Rows = { rows: any[]; command?: string };
type Tamper = (sql: string, answer: Rows) => Rows;

function tampered(session: PgSession, tamper: Tamper): PgSession {
  return new Proxy(session as any, {
    get(target, prop) {
      if (prop === 'query') return async (sql: string, params?: unknown[]) => tamper(sql, await target.query(sql, params));
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });
}

async function run(db: FakeDb, jobId: string, tamper?: Tamper) {
  const extra: ServiceOptions = { rootConfigPath: CFG, sourceModulesDir: MODS };
  if (tamper) extra.connect = async (_url, app) => tampered(db.connect(app) as unknown as PgSession, tamper);
  const service = serviceFor(db, new FakeHost(), extra);
  await service.post({ jobId, to: 'postgres' });
  await service.idle();
  return service.status().body.job;
}

const DOCS_SQL = "SELECT key, sha, encode(sha256(body), 'hex') AS h FROM smdb_data.shared_docs";
const MODS_SQL = 'SELECT module, sha FROM smdb_data.shared_modules';

describe('ra50: insertValues numbers one parameter per placeholder', () => {
  it('sends each row as a tuple of numbered parameters and keeps a literal in place', async () => {
    const sent: Array<{ sql: string; params: unknown[] }> = [];
    const session: PgSession = { query: async (sql, params) => { sent.push({ sql, params: params ?? [] }); return { rows: [] }; }, end: async () => undefined };
    await insertValues(session, 'INSERT INTO t (a, r, b)', ['$', REV, '$'], [['x', 'y'], ['z', 'w']]);
    expect(sent).toEqual([{ sql: `INSERT INTO t (a, r, b) VALUES ($1, ${REV}, $2), ($3, ${REV}, $4)`, params: ['x', 'y', 'z', 'w'] }]);
  });
});

describe('ra50: a move to Postgres sends each shared insert in the column shape of its table', () => {
  it('numbers the doc, line, module and module file parameters in the order of their columns', async () => {
    seedSource();
    const db = new FakeDb();
    const job = await run(db, 'job-ra50-shape-01');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const inserts = db.statements().filter(s => /^INSERT INTO smdb_data\.shared_/.test(s));
    const docs = inserts.filter(s => s.startsWith('INSERT INTO smdb_data.shared_docs '));
    expect(docs.length).toBe(3);
    for (const s of docs) expect(s).toBe(`INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by) VALUES ($1, $2, $3, ${REV}, $4)`);
    expect(inserts.filter(s => s.startsWith('INSERT INTO smdb_data.shared_lines '))).toEqual(['INSERT INTO smdb_data.shared_lines (key, id, line) VALUES ($1, $2, $3), ($4, $5, $6)']);
    expect(inserts.filter(s => s.startsWith('INSERT INTO smdb_data.shared_modules '))).toEqual([
      `INSERT INTO smdb_data.shared_modules (module, sha, rev, version, file_count, bytes, updated_by) VALUES ($1, $2, ${REV}, $3, $4, $5, $6)`,
    ]);
    expect(inserts.filter(s => s.startsWith('INSERT INTO smdb_data.shared_module_files '))).toEqual([
      'INSERT INTO smdb_data.shared_module_files (module, rel, bytes, mode) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
    ]);
  });
});

describe('ra50: the read-back of the shared rows names what differs', () => {
  it('fails when a doc the source holds is missing from the destination', async () => {
    seedSource();
    const db = new FakeDb();
    const job = await run(db, 'job-ra50-miss-01', (sql, a) => (sql === DOCS_SQL ? { ...a, rows: a.rows.filter(r => r.key !== 'global/m/a.json') } : a));
    expect(job, why(job)).toMatchObject({ state: 'failed' });
    expect(why(job)).toContain('The shared files read back from the destination differ from the source (global/m/a.json: missing from the destination); nothing was switched');
  });

  it('fails when the destination holds a doc the source does not', async () => {
    seedSource();
    const db = new FakeDb();
    const extra = { key: 'global/m/extra.json', sha: 'ab', h: 'ab' };
    const job = await run(db, 'job-ra50-extra-01', (sql, a) => (sql === DOCS_SQL ? { ...a, rows: [...a.rows, extra] } : a));
    expect(job, why(job)).toMatchObject({ state: 'failed' });
    expect(why(job)).toContain('The shared files read back from the destination differ from the source (global/m/extra.json: not in the source); nothing was switched');
  });

  it("fails when a doc's stored sha does not match its bytes", async () => {
    seedSource();
    const db = new FakeDb();
    const job = await run(db, 'job-ra50-sha-01', (sql, a) => (sql === DOCS_SQL ? { ...a, rows: a.rows.map(r => (r.key === 'global/m/a.json' ? { ...r, sha: '00' } : r)) } : a));
    expect(job, why(job)).toMatchObject({ state: 'failed' });
    expect(why(job)).toContain('The shared files read back from the destination differ from the source (global/m/a.json: its stored sha does not match its bytes); nothing was switched');
  });

  it("calls a module's mismatch a difference of the module files", async () => {
    seedSource();
    const db = new FakeDb();
    const job = await run(db, 'job-ra50-mod-01', (sql, a) => (sql === MODS_SQL ? { ...a, rows: a.rows.map(r => ({ ...r, sha: '00' })) } : a));
    expect(job, why(job)).toMatchObject({ state: 'failed' });
    expect(why(job)).toContain('The module files read back from the destination differ from the source (mod1: its stored sha does not match its files); nothing was switched');
  });
});
