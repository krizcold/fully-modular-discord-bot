import fs from 'fs';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3's job from S1 to S9: the S2 checks (the env file, a bundle import, the marker, DATA_BACKEND_URL, the store id read
// and server_encoding), the COMMIT, and what a failed or interrupted job leaves in the journal, the log and the database.

const hook = vi.hoisted(() => ({ atomic: null as null | ((file: string, contents: string, write: () => void) => void) }));
vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string, keep?: { mode: number; uid: number; gid: number }) => {
      const write = () => real.atomicWriteFileSync(file, contents, keep);
      if (hook.atomic) hook.atomic(file, contents, write);
      else write();
    },
  };
});

import type { PgSession, ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

const G1 = '660000000000000001';
const G2 = '660000000000000002';
const pgError = (code: string, text: string) => Object.assign(new Error(text), { code, severity: 'ERROR' });

beforeEach(() => {
  wipeRoot();
  hook.atomic = null;
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  loadCredentials();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  hook.atomic = null;
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
});

/** The fake's client with an override per statement, and a socket whose destroy is recorded. */
function recording(db: FakeDb, override?: (sql: string, app: string) => Promise<any> | undefined) {
  const destroyed: string[] = [];
  const connect = async (_url: string, app: string): Promise<PgSession> => {
    const client = db.connect(app);
    const session = {
      query: (text: string, params: any[] = []) => override?.(text.replace(/\s+/g, ' ').trim(), app) ?? client.query(text, params),
      end: () => client.end(),
      connection: { stream: { destroy: () => { destroyed.push(app); void client.end(); } } },
    };
    return session as unknown as PgSession;
  };
  return { connect, destroyed };
}

function jsonSource(): void {
  freshJsonBot();
  seedFile(`${G1}/mod/a.json`, '{"a":1}');
}

function pgSource(db: FakeDb, storeId = 'src-s7'): void {
  freshJsonBot();
  writeJson(MARKER, { live: 'postgres', storeId, flippedAt: 1 });
  db.schemas.set('smdb_data', {
    ...emptyStore(storeId),
    data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }, { guild_id: G2, module: 'm', filename: 'b.json', doc: '{"b":2}' }],
  });
}

async function run(db: FakeDb, jobId: string, to: 'postgres' | 'file', extra: ServiceOptions = {}) {
  const service = serviceFor(db, new FakeHost(), extra);
  const answer = await service.post({ jobId, to });
  await service.idle();
  return { answer, job: service.status().body.job };
}

/** The statements the job's own sessions sent after the last COMMIT. */
function afterLastCommit(db: FakeDb, jobId: string): string[] {
  const own = db.statements(`smdb-migrate:${jobId}`);
  return own.slice(own.lastIndexOf('COMMIT') + 1);
}

describe('S1: the start', () => {
  it('answers started at checking and logs the start', async () => {
    jsonSource();
    const { answer } = await run(new FakeDb(), 'job-s7-start-1', 'postgres');
    expect(answer).toEqual({ status: 200, body: { success: true, jobId: 'job-s7-start-1', to: 'postgres', state: 'started', stage: 'checking' } });
    expect(console.log).toHaveBeenCalledWith('[Migration] Migration job-s7-start-1 (--to postgres) started');
  });
});

describe('S2: the checks', () => {
  it('a /data/.env that loads but then cannot be read refuses, naming the file and the error', async () => {
    jsonSource();
    seedFile('.env', 'A=1\n');
    const envPath = dataPath('.env');
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      const stack = new Error().stack ?? '';
      if (path.resolve(String(p)) === path.resolve(envPath) && /checkEnvAndData/.test(stack) && !/loadCredentials/.test(stack)) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return (real as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const { job } = await run(new FakeDb(), 'job-s7-env-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe(`${envPath} cannot be read: EACCES: permission denied`);
  });

  it('a bundle import in progress refuses, naming every import', async () => {
    jsonSource();
    fs.mkdirSync(path.join(root, '.bundle-import-a'));
    fs.mkdirSync(path.join(root, '.bundle-import-b'));
    const named = fs.readdirSync(root).filter(n => n.startsWith('.bundle-import-')).map(n => path.join(root, n));
    const db = new FakeDb();
    const { job } = await run(db, 'job-s7-bundle1', 'postgres');
    expect(job.error).toBe(`A bundle import is in progress (${named.join(', ')}); run the migration once it ends`);
    expect(db.schemas.size).toBe(0);
  });

  it('a marker that names the destination by S2 refuses', async () => {
    jsonSource();
    const db = new FakeDb();
    const { job } = await run(db, 'job-s7-marker1', 'postgres', {
      fault: point => { if (point === 'S2') writeJson(MARKER, { live: 'postgres', storeId: 'elsewhere', flippedAt: 2 }); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: 'The data is already on postgres' });
    expect(db.schemas.size).toBe(0);
  });

  it('a data root with neither marker nor journal at S2 reads as JSON, and the move to Postgres goes on', async () => {
    jsonSource();
    const { job } = await run(new FakeDb(), 'job-s7-nomark-1', 'postgres', {
      fault: point => {
        if (point !== 'S2') return;
        fs.rmSync(MARKER);
        fs.rmSync(path.join(root, '.migration.json'));
      },
    });
    expect(job, why(job)).toMatchObject({ state: 'done', to: 'postgres' });
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres', migration: 'job-s7-nomark-1' });
  });

  it('an unset DATA_BACKEND_URL refuses as not set', async () => {
    jsonSource();
    delete process.env.DATA_BACKEND_URL;
    const { job } = await run(new FakeDb(), 'job-s7-nourl-1', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: 'DATA_BACKEND_URL is not set, so the database is unknown' });
  });

  it('a DATA_BACKEND_URL with a trailing no-break space is used trimmed: the address connected to and the destination recorded', async () => {
    jsonSource();
    process.env.DATA_BACKEND_URL = PG_URL + String.fromCharCode(0xa0);
    const db = new FakeDb();
    const urls: string[] = [];
    const { job } = await run(db, 'job-s7-nbsp-01', 'postgres', { connect: async (url, app) => { urls.push(url); return db.connect(app); } });
    expect(job, why(job)).toMatchObject({ state: 'done', destination: { host: 'db.example', port: 5432, database: 'smdb' } });
    expect(new Set(urls)).toEqual(new Set([PG_URL]));
  });

  it('a store id read that rejects with no error object refuses with can\'t confirm', async () => {
    jsonSource();
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('held-s7'));
    const rec = recording(db, (sql, app) => (app.startsWith('smdb-migrate:') && /\.meta WHERE key = 'store_id'/.test(sql) ? Promise.reject(undefined) : undefined));
    const { job } = await run(db, 'job-s7-meta-01', 'postgres', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe("can't confirm the store id of smdb_data at db.example:5432/smdb: undefined");
  });

  it('a store id read that answers 3F000 reads as no store', async () => {
    const db = new FakeDb();
    pgSource(db);
    const rec = recording(db, (sql, app) => (app.startsWith('smdb-migrate:') && /smdb_data"?\.meta WHERE key = 'store_id'/.test(sql)
      ? Promise.reject(pgError('3F000', 'schema "smdb_data" does not exist')) : undefined));
    const { job } = await run(db, 'job-s7-meta-02', 'file', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe('The database holds store none, not the store /data/.backend.json names (src-s7)');
  });

  it('a database that is not UTF8 refuses; the log says failed, and no ROLLBACK is sent outside a transaction', async () => {
    jsonSource();
    const db = new FakeDb();
    db.encoding = 'SQL_ASCII';
    const { job } = await run(db, 'job-s7-enc-001', 'postgres');
    const text = "The database's server_encoding is SQL_ASCII, not UTF8";
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: text });
    expect(console.error).toHaveBeenCalledWith(`[Migration] Migration job-s7-enc-001 failed at checking: ${text}`);
    expect(db.statements('smdb-migrate:job-s7-enc-001').filter(s => /^ROLLBACK/.test(s))).toEqual([]);
    expect(db.schemas.size).toBe(0);
  });

  it('a server_encoding read with no row refuses, naming an empty encoding', async () => {
    jsonSource();
    const db = new FakeDb();
    const rec = recording(db, sql => (sql === 'SHOW server_encoding' ? Promise.resolve({ rows: [] }) : undefined));
    const { job } = await run(db, 'job-s7-enc-002', 'postgres', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: "The database's server_encoding is , not UTF8" });
  });

  it('a failed job whose journal cannot be written logs that', async () => {
    jsonSource();
    const db = new FakeDb();
    db.encoding = 'LATIN1';
    hook.atomic = (file, contents, write) => {
      if (path.basename(file) === '.migration.json' && /"result": "failed"/.test(contents)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      write();
    };
    await run(db, 'job-s7-jrnl-01', 'postgres');
    expect(console.error).toHaveBeenCalledWith('[Migration] The journal of migration job-s7-jrnl-01 could not be written: EIO: i/o error');
    expect(readJson(path.join(root, '.migration.json')).result).toBeUndefined();
  });
});

describe('the COMMIT and what follows it', () => {
  it('a failure after the retire COMMIT is interrupted at retire-source, and nothing is rolled back', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s7-retire');
    const { job } = await run(db, 'job-s7-retire1', 'file', { fault: point => { if (point === 'after-retire-commit') throw new Error('boom'); } });
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'retire-source' });
    expect(readJson(path.join(root, '.migration.json'))).toMatchObject({ result: 'interrupted', stage: 'retire-source', error: 'boom' });
    expect(console.error).toHaveBeenCalledWith('[Migration] Migration job-s7-retire1 was interrupted at retire-source: boom');
    expect(afterLastCommit(db, 'job-s7-retire1').filter(s => /^ROLLBACK/.test(s))).toEqual([]);
    expect(db.schemas.has('smdb_data')).toBe(false);
  });

  it('a COMMIT with no answer names its bound in seconds', async () => {
    jsonSource();
    const db = new FakeDb();
    const rec = recording(db, (sql, app) => (app.startsWith('smdb-migrate:') && sql === 'COMMIT' ? new Promise(() => undefined) : undefined));
    const { job } = await run(db, 'job-s7-commit1', 'postgres', { connect: rec.connect, commitBoundMs: 500, closeBoundMs: 50 });
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(path.join(root, '.migration.json')).error).toBe('The COMMIT got no answer within 1 s');
  });

  it('a COMMIT the database refuses fails the job and sends no ROLLBACK after it', async () => {
    jsonSource();
    const db = new FakeDb();
    db.fail = (sql, app) => (app.startsWith('smdb-migrate:') && sql === 'COMMIT' ? pgError('40001', 'could not serialize access') : undefined);
    const { job } = await run(db, 'job-s7-commit2', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', error: 'The database refused the COMMIT: could not serialize access' });
    expect(afterLastCommit(db, 'job-s7-commit2')).toEqual(['SELECT 1']);
  });

  it('a COMMIT error whose SELECT 1 then fails is can\'t confirm, and the session is ended, not destroyed', async () => {
    jsonSource();
    const db = new FakeDb();
    let committed = false;
    const rec = recording(db, (sql, app) => {
      if (!app.startsWith('smdb-migrate:')) return undefined;
      if (sql === 'COMMIT') {
        committed = true;
        return Promise.reject(pgError('XX000', 'internal error'));
      }
      if (committed && sql === 'SELECT 1') return Promise.reject(new Error('Connection terminated unexpectedly'));
      return undefined;
    });
    const { job } = await run(db, 'job-s7-commit3', 'postgres', { connect: rec.connect, closeBoundMs: 50 });
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(path.join(root, '.migration.json')).error).toBe("can't confirm whether the COMMIT landed: internal error");
    expect(rec.destroyed).toEqual([]);
  });
});
