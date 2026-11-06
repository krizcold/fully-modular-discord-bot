import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgSession, ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import {
  FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, seedFile, serviceFor, snapshotRoot, useDatabaseUrl, wipeRoot, writeJson,
} from '../helpers/migrationRig';

// NB3 S0: how a request is classified against the journal and marker an earlier job left, and the one database read
// it makes for that. Each answer is checked by its exact text, and a refusal leaves every file under /data as it was.

const ADDRESS_LIST = 'DATA_BACKEND_URL lists 2 database addresses (live copies on other machines); a migration needs one database address, so remove the live copies first';
const SOURCE = { host: 'db.example', port: 5432, database: 'smdb' };
const NEW = 'job-c6-new0001';

const pgError = (code: string, text: string) => Object.assign(new Error(text), { code, severity: 'ERROR' });

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

/** An earlier move to JSON whose Postgres source is store src-1 at db.example. */
function earlierToFile(extra: Record<string, unknown> = {}): void {
  writeJson(MARKER, { live: 'postgres', storeId: 'src-1', flippedAt: 1 });
  writeJson(JOURNAL, {
    jobId: 'job-c6-file001', to: 'file', stage: 'switching', result: 'interrupted', error: 'x', startedAt: 1,
    sourceStoreId: 'src-1', source: SOURCE, ...extra,
  });
  seedFile('.env', 'DATA_BACKEND=postgres\n');
}

/** An earlier move to Postgres that ended after its read, with a destination at db.example. */
function earlierCopy(): void {
  writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
  writeJson(JOURNAL, { jobId: 'job-c6-copy001', to: 'postgres', stage: 'copying', startedAt: 1, destination: SOURCE });
}

function recording(db: FakeDb, wrap?: (s: PgSession) => PgSession): { calls: Array<{ url: string; app: string }>; opts: ServiceOptions } {
  const calls: Array<{ url: string; app: string }> = [];
  return {
    calls,
    opts: {
      connect: async (url, app) => {
        calls.push({ url, app });
        const s = db.connect(app);
        return wrap ? wrap(s) : s;
      },
    },
  };
}

describe('the fallback answer of a request that could not be answered', () => {
  it('a request waiting on the first one gets a 500 that says so when the first one\'s own error log throws', async () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-c6-old0001', to: 'postgres', stage: 'checking', startedAt: 1 });
    vi.mocked(console.warn).mockImplementation(() => { throw new Error('the log is gone'); });
    vi.mocked(console.error).mockImplementation(() => { throw new Error('the log is gone'); });
    const host = new FakeHost();
    const service = serviceFor(new FakeDb(), host);
    const first = service.post({ jobId: NEW, to: 'postgres' });
    const second = service.post({ jobId: 'job-c6-new0002', to: 'postgres' });
    await expect(first).rejects.toThrow('the log is gone');
    expect(await second).toEqual({ status: 500, body: { success: false, error: 'The request could not be answered' } });
    expect(host.lock).toBeNull();
  });
});

describe('S0 refusals before an earlier job is looked at', () => {
  it('an address list in the request is refused as one, even when the data is already on the asked side', async () => {
    freshJsonBot();
    const before = snapshotRoot();
    const answer = await serviceFor(new FakeDb()).post({ jobId: NEW, to: 'file', url: 'postgres://a.example/smdb,postgres://b.example/smdb' });
    expect(answer).toEqual({ status: 409, body: { success: false, error: ADDRESS_LIST } });
    expect(snapshotRoot()).toEqual(before);
  });

  it('NB5 C6: a url with an empty entry names that entry and counts no live copy for it', async () => {
    freshJsonBot();
    const before = snapshotRoot();
    const trailing = await serviceFor(new FakeDb()).post({ jobId: NEW, to: 'file', url: 'postgres://a.example/smdb,' });
    expect(trailing).toEqual({ status: 409, body: { success: false, error: 'entry 2 of DATA_BACKEND_URL must start with postgresql:// or postgres://' } });
    const middle = await serviceFor(new FakeDb()).post({ jobId: NEW, to: 'file', url: 'postgres://a.example/smdb,,postgres://b.example/smdb' });
    expect(middle).toEqual({ status: 409, body: { success: false, error: 'entry 2 of DATA_BACKEND_URL must start with postgresql:// or postgres://' } });
    expect(snapshotRoot()).toEqual(before);
  });

  it('a failed earlier job of the other direction does not turn "already on file" into an unfinished-job refusal', async () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-c6-pg00001', to: 'postgres', stage: 'copying', result: 'failed', error: 'x', startedAt: 1 });
    const answer = await serviceFor(new FakeDb()).post({ jobId: NEW, to: 'file' });
    expect(answer).toEqual({ status: 409, body: { success: false, error: 'The data is already on file' } });
  });

  it('an earlier journal that cannot be marked failed refuses, names the error, starts nothing and keeps the lock free', async () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-c6-old0001', to: 'postgres', stage: 'checking', startedAt: 1 });
    const before = snapshotRoot();
    const real = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p).startsWith(`${JOURNAL}.`)) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      return (real as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const host = new FakeHost();
    const service = serviceFor(new FakeDb(), host);
    const answer = await service.post({ jobId: NEW, to: 'postgres' });
    await service.idle();
    expect(answer).toEqual({
      status: 409,
      body: { success: false, error: 'The earlier journal could not be written, so nothing was started: EROFS: read-only file system' },
    });
    expect(snapshotRoot()).toEqual(before);
    expect(host.lock).toBeNull();
  });
});

describe('S0 against the marker an earlier job of the same direction left', () => {
  it('a done journal the marker does not name answers "can\'t confirm" and finishes nothing', async () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1, migration: 'job-c6-done001' });
    writeJson(JOURNAL, { jobId: 'job-c6-done001', to: 'postgres', stage: 'env', result: 'done', storeId: 's1', startedAt: 1, finishedAt: 2 });
    seedFile('.env', 'DATA_BACKEND=file\n');
    const before = snapshotRoot();
    const answer = await serviceFor(new FakeDb()).post({ jobId: NEW, to: 'postgres' });
    expect(answer).toEqual({
      status: 409,
      body: { success: false, error: "can't confirm; migration job-c6-done001 says done, but /data/.backend.json does not name it", jobId: 'job-c6-done001', to: 'postgres' },
    });
    expect(snapshotRoot()).toEqual(before);
  });

  it('a marker on the same side under no migration answers "can\'t confirm" naming that', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: 's1', flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-c6-pg00002', to: 'postgres', stage: 'copying', startedAt: 1 });
    seedFile('.env', 'DATA_BACKEND=file\n');
    const before = snapshotRoot();
    const answer = await serviceFor(new FakeDb()).post({ jobId: NEW, to: 'postgres' });
    expect(answer.body.error).toBe("can't confirm; the marker /data/.backend.json names postgres under no migration, not migration job-c6-pg00002");
    expect(answer.body).toMatchObject({ success: false, jobId: 'job-c6-pg00002', to: 'postgres' });
    expect(snapshotRoot()).toEqual(before);
  });

  it('a marker on the same side under another migration answers "can\'t confirm" naming both', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: 's1', flippedAt: 1, migration: 'job-c6-pg00001' });
    writeJson(JOURNAL, { jobId: 'job-c6-pg00002', to: 'postgres', stage: 'copying', startedAt: 1 });
    const answer = await serviceFor(new FakeDb()).post({ jobId: NEW, to: 'postgres' });
    expect(answer.body.error).toBe("can't confirm; the marker /data/.backend.json names postgres under migration job-c6-pg00001, not migration job-c6-pg00002");
  });
});

describe('S0 for an earlier move to JSON', () => {
  const post = (db: FakeDb, opts: ServiceOptions = {}) => serviceFor(db, new FakeHost(), opts).post({ jobId: NEW, to: 'file' });

  it('no recorded source store id answers "can\'t confirm" naming the job', async () => {
    writeJson(MARKER, { live: 'postgres', flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-c6-file002', to: 'file', stage: 'copying', startedAt: 1 });
    const answer = await post(new FakeDb());
    expect(answer.body.error).toBe("can't confirm; no store id is recorded for the source of migration job-c6-file002");
  });

  it('a DATA_BACKEND_URL that is a list, or not set, is not one database address', async () => {
    earlierToFile();
    const db = new FakeDb();
    db.schemas.set('smdb_superseded_1', emptyStore('src-1'));
    process.env.DATA_BACKEND_URL = 'postgres://bot:pw@db.example:5432/smdb,postgres://bot:pw@db.example:5433/smdb';
    const before = snapshotRoot();
    expect((await post(db)).body.error).toBe("can't confirm; DATA_BACKEND_URL is not one database address");
    delete process.env.DATA_BACKEND_URL;
    expect((await post(db)).body.error).toBe("can't confirm; DATA_BACKEND_URL is not one database address");
    expect(snapshotRoot()).toEqual(before);
  });

  it('a DATA_BACKEND_URL that is not a URL cannot be parsed', async () => {
    earlierToFile();
    process.env.DATA_BACKEND_URL = 'nonsense';
    expect((await post(new FakeDb())).body.error).toBe("can't confirm; DATA_BACKEND_URL cannot be parsed");
  });

  it('a DATA_BACKEND_URL other than the address the source was read at answers "can\'t confirm" naming both', async () => {
    earlierToFile({ source: { host: 'other.host', port: 5432, database: 'smdb' } });
    const db = new FakeDb();
    db.schemas.set('smdb_superseded_1', emptyStore('src-1'));
    const before = snapshotRoot();
    const answer = await post(db);
    expect(answer.body.error).toBe("can't confirm; DATA_BACKEND_URL names db.example:5432/smdb, not other.host:5432/smdb, where migration job-c6-file001 read its source");
    expect(snapshotRoot()).toEqual(before);
    expect(db.sessions).toEqual([]);
  });

  it('the database is asked at the trimmed DATA_BACKEND_URL, under the new job\'s session name', async () => {
    earlierToFile();
    process.env.DATA_BACKEND_URL = `  ${PG_URL}  `;
    const db = new FakeDb();
    const rec = recording(db);
    const answer = await post(db, rec.opts);
    expect(answer.body.error).toBe("can't confirm; neither smdb_data nor a superseded schema holds store src-1");
    expect(rec.calls).toEqual([{ url: PG_URL, app: `smdb-migrate:${NEW}` }]);
  });

  it('a store held both in smdb_data and in a superseded schema answers "can\'t confirm" and switches nothing', async () => {
    earlierToFile();
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('src-1'));
    db.schemas.set('smdb_superseded_1', emptyStore('src-1'));
    const before = snapshotRoot();
    const answer = await post(db);
    expect(answer.body.error).toBe("can't confirm; both smdb_data and a superseded schema hold store src-1");
    expect(snapshotRoot()).toEqual(before);
  });

  it('every superseded schema whose meta cannot be read is named, joined by "; "', async () => {
    earlierToFile();
    const db = new FakeDb();
    db.schemas.set('smdb_superseded_1', { ...emptyStore(null), noMeta: true });
    db.schemas.set('smdb_superseded_2', { ...emptyStore(null), noMeta: true });
    const answer = await post(db);
    expect(answer.body.error).toBe(
      "can't confirm; the meta of smdb_superseded_1 could not be read: relation \"smdb_superseded_1.meta\" does not exist; "
      + 'the meta of smdb_superseded_2 could not be read: relation "smdb_superseded_2.meta" does not exist',
    );
  });

  it('a store held nowhere answers "can\'t confirm" and starts no job', async () => {
    earlierToFile();
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('other-store'));
    const before = snapshotRoot();
    const answer = await post(db);
    expect(answer.body).toEqual({
      success: false, error: "can't confirm; neither smdb_data nor a superseded schema holds store src-1", jobId: 'job-c6-file001', to: 'file',
    });
    expect(snapshotRoot()).toEqual(before);
  });

  it('smdb_data read as a missing schema (3F000) counts as absent, so the superseded source finishes the switch', async () => {
    earlierToFile();
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('src-1'));
    db.schemas.set('smdb_superseded_1', emptyStore('src-1'));
    db.fail = sql => (/"smdb_data"\.meta/.test(sql) ? pgError('3F000', 'schema "smdb_data" does not exist') : undefined);
    const answer = await post(db);
    expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ success: true, jobId: 'job-c6-file001', state: 'done' });
    expect(readJson(MARKER)).toMatchObject({ live: 'file', migration: 'job-c6-file001' });
  });

  it('any other error reading smdb_data answers "can\'t confirm" naming it, and switches nothing', async () => {
    earlierToFile();
    const db = new FakeDb();
    db.schemas.set('smdb_superseded_1', emptyStore('src-1'));
    db.fail = sql => (/"smdb_data"\.meta/.test(sql) ? pgError('42501', 'permission denied for schema smdb_data') : undefined);
    const before = snapshotRoot();
    const answer = await post(db);
    expect(answer.body.error).toBe("can't confirm; the database at db.example:5432/smdb (from DATA_BACKEND_URL) could not be read: permission denied for schema smdb_data");
    expect(snapshotRoot()).toEqual(before);
  });

  it('a driver that rejects with no error object is reported as it came', async () => {
    earlierToFile();
    const db = new FakeDb();
    db.schemas.set('smdb_superseded_1', emptyStore('src-1'));
    const rec = recording(db, s => ({
      query: (text: string, params?: unknown[]) => (/"smdb_data"\.meta/.test(text) ? Promise.reject(undefined) : s.query(text, params)),
      end: () => s.end(),
    }));
    const answer = await post(db, rec.opts);
    expect(answer.body.error).toBe("can't confirm; the database at db.example:5432/smdb (from DATA_BACKEND_URL) could not be read: undefined");
  });

  it('a session count read that answers no row counts as no session', async () => {
    earlierToFile();
    const db = new FakeDb();
    db.schemas.set('smdb_superseded_1', emptyStore('src-1'));
    const rec = recording(db, s => ({
      query: async (text: string, params?: unknown[]) => (/pg_stat_activity/.test(text) ? { rows: [] } : s.query(text, params)),
      end: () => s.end(),
    }));
    const answer = await post(db, rec.opts);
    expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ success: true, jobId: 'job-c6-file001', state: 'done' });
  });

  it('a connect slower than 2 s answers "can\'t confirm", and the session it opens later is closed at once', async () => {
    earlierToFile();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let open!: (s: PgSession) => void;
    const ended = vi.fn(async () => undefined);
    const service = serviceFor(new FakeDb(), new FakeHost(), { connect: () => new Promise<PgSession>(resolve => { open = resolve; }) });
    const pending = service.post({ jobId: NEW, to: 'file' });
    await vi.advanceTimersByTimeAsync(2000);
    const answer = await pending;
    expect(answer.body.error).toBe("can't confirm; the database at db.example:5432/smdb (from DATA_BACKEND_URL) could not be read: the connection to the database took longer than 2 s");
    expect(ended).not.toHaveBeenCalled();
    open({ query: async () => ({ rows: [] }), end: ended });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe('S0 for an earlier move to Postgres that ended after its read', () => {
  it('a refused login names the address and that it came from the request', async () => {
    earlierCopy();
    const db = new FakeDb();
    db.refuseLogin = true;
    const answer = await serviceFor(db).post({ jobId: NEW, to: 'postgres', url: PG_URL });
    expect(answer.body.error).toBe("The database refused the bot's login at db.example:5432/smdb (from the address given in the request)");
    expect(answer.body).toMatchObject({ success: false, jobId: 'job-c6-copy001', to: 'postgres' });
  });

  it('a refused login names the address and that it came from DATA_BACKEND_URL', async () => {
    earlierCopy();
    const db = new FakeDb();
    db.refuseLogin = true;
    const answer = await serviceFor(db).post({ jobId: NEW, to: 'postgres' });
    expect(answer.body.error).toBe("The database refused the bot's login at db.example:5432/smdb (from DATA_BACKEND_URL)");
  });

  it('the database is asked at the trimmed DATA_BACKEND_URL', async () => {
    earlierCopy();
    process.env.DATA_BACKEND_URL = `  ${PG_URL}  `;
    const db = new FakeDb();
    db.refuseLogin = true;
    const rec = recording(db);
    await serviceFor(db, new FakeHost(), rec.opts).post({ jobId: NEW, to: 'postgres' });
    expect(rec.calls.map(c => c.url)).toEqual([PG_URL]);
  });

  it('a DATA_BACKEND_URL that is a list is not asked, so the earlier job is stale and a new one starts', async () => {
    earlierCopy();
    process.env.DATA_BACKEND_URL = `${PG_URL}?options=a,b`;
    const db = new FakeDb();
    db.refuseLogin = true;
    const service = serviceFor(db);
    const answer = await service.post({ jobId: NEW, to: 'postgres' });
    await service.idle();
    expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ success: true, jobId: NEW, state: 'started' });
  });

  it('only the open sessions are read, so a store id that cannot be read does not stop the new job', async () => {
    earlierCopy();
    const db = new FakeDb();
    db.fail = sql => (/"smdb_data"\.meta/.test(sql) ? pgError('XX000', 'boom') : undefined);
    const service = serviceFor(db);
    const answer = await service.post({ jobId: NEW, to: 'postgres' });
    db.fail = null;
    await service.idle();
    expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ success: true, jobId: NEW, state: 'started' });
  });
});
