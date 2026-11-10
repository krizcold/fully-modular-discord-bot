import fs from 'fs';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listPgUnits, normalizeAddress, readPgUnit, snapshotFromPgRows, watchSession, type PgSession,
} from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { ENV, FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 code review round 2, the job's side: R2-1 to R2-4, OPS-3, OPS-4, OPS-6 and finish() keeping a done journal's finishedAt.

const G1 = '880000000000000001';
const G2 = '880000000000000002';
const NEXT_STEP = 'the database ends it once it notices the connection is gone; run the migration again once it no longer shows';

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  loadCredentials();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
});

function pgSource(db: FakeDb, storeId = 'src-r2', grave: any[] = []): void {
  writeJson(MARKER, { live: 'postgres', storeId, flippedAt: 1 });
  db.schemas.set('smdb_data', {
    ...emptyStore(storeId),
    data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }, { guild_id: G2, module: 'm', filename: 'b.json', doc: '{"b":2}' }],
    grave,
  });
}

/** The fake's client with each statement seen, an override per statement, and a socket whose destroy is recorded. */
function recording(db: FakeDb, override?: (sql: string, app: string) => Promise<any> | undefined) {
  const destroyed: string[] = [];
  const seen: Array<{ app: string; sql: string; params: any[] }> = [];
  const connect = async (_url: string, app: string): Promise<PgSession> => {
    const client = db.connect(app);
    const session = {
      query: (text: string, params: any[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        seen.push({ app, sql, params });
        return override?.(sql, app) ?? client.query(text, params);
      },
      end: () => client.end(),
      connection: { stream: { destroy: () => { destroyed.push(app); void client.end(); } } },
    };
    return session as unknown as PgSession;
  };
  return { connect, destroyed, seen };
}

const never = () => new Promise<never>(() => undefined);
const graveRow = (retired: string, module = 'm', filename = 'g.json') => ({ guild_id: G1, module, filename, kind: 'doc', doc: '{"g":1}', retired_at: retired, reason: 'left' });
const migrateFolders = () => fs.readdirSync(root).filter(n => n.startsWith('.migrate-'));

describe('NB3-R2-1: a Postgres graveyard entry is read by the text Postgres returned', () => {
  it('lists an entry whose retired_at is not a safe integer under leftOut, named, and lists the others', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r2-1', [graveRow('1700000000000'), graveRow('9007199254740993')]);
    const leftOut: string[] = [];
    const units = await listPgUnits(db.connect('t') as unknown as PgSession, leftOut);
    expect(units.filter(u => u.retiredAt !== undefined)).toEqual([{ guildId: G1, retiredAt: 1700000000000, retiredText: '1700000000000' }]);
    expect(leftOut).toEqual([`graveyard entry ${G1}-9007199254740993 in the database (its retired_at cannot name a folder exactly)`]);
  });

  it('reads an entry with the retired_at text it listed', async () => {
    const params: any[][] = [];
    const session = { query: async (_sql: string, p: any[] = []) => { params.push(p); return { rows: [graveRow('9007199254740991')] }; }, end: async () => undefined };
    await readPgUnit(session, { guildId: G1, retiredAt: 9007199254740991, retiredText: '9007199254740991' });
    expect(params[0]).toEqual([G1, '9007199254740991']);
  });

  it('a listed unit that reads zero rows refuses, naming it', async () => {
    const empty = { query: async () => ({ rows: [] }), end: async () => undefined };
    await expect(readPgUnit(empty, { guildId: G1, retiredAt: 17, retiredText: '17' })).rejects.toThrow(`The database lists graveyard entry ${G1}-17, but its read found no rows`);
    await expect(readPgUnit(empty, { guildId: G2 })).rejects.toThrow(`The database lists guild ${G2}, but its read found no rows`);
  });

  it('the job to JSON copies the safe entry, names the other under leftOut, and the superseded schema keeps its rows', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r2-1b', [graveRow('1700000000000'), graveRow('9007199254740993')]);
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-r2-1-0001', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(job.counts.graveyardEntries).toBe(1);
    expect(job.leftOut).toEqual([`graveyard entry ${G1}-9007199254740993 in the database (its retired_at cannot name a folder exactly)`]);
    expect(fs.existsSync(`${root}/_graveyard/${G1}-1700000000000/m/g.json`)).toBe(true);
    expect(fs.readdirSync(`${root}/_graveyard`)).toEqual([`${G1}-1700000000000`]);
    const aside = [...db.schemas.keys()].filter(n => n.startsWith('smdb_superseded_'));
    expect(aside).toHaveLength(1);
    expect(db.schemas.get(aside[0])!.grave.map(r => r.retired_at)).toContain('9007199254740993');
  });

  it('the job fails at reading, naming the guild, when a listed guild reads zero rows', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r2-1c');
    const rec = recording(db, (sql, app) => (app.startsWith('smdb-migrate:') && /WHERE guild_id = \$1/.test(sql) && /guild_data|guild_append/.test(sql)
      && rec.seen[rec.seen.length - 1].params[0] === G2 ? Promise.resolve({ rows: [] }) : undefined));
    const service = serviceFor(db, new FakeHost(), { connect: rec.connect });
    await service.post({ jobId: 'job-r2-1-0002', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job.error).toBe(`The database lists guild ${G2}, but its read found no rows`);
    expect(db.schemas.get('smdb_data')?.storeId).toBe('src-r2-1c');
    expect(readJson(MARKER).live).toBe('postgres');
  });
});

describe('NB3-R2-2: S0 keeps each superseded schema whose meta read fails', () => {
  function earlierToFile(db: FakeDb, sourceId: string): void {
    pgSource(db, sourceId);
    writeJson(JOURNAL, { jobId: 'job-r2-2-early', to: 'file', stage: 'retire-source', sourceStoreId: sourceId, startedAt: 1 });
  }
  const unreadable = (db: FakeDb, name: string) => db.schemas.set(name, { ...emptyStore(null), noMeta: true });

  it('an answer that would be stale is case 4, naming the schema and its error; the journal is unchanged', async () => {
    const db = new FakeDb();
    earlierToFile(db, 'src-r2-2a');
    unreadable(db, 'smdb_superseded_1');
    const before = fs.readFileSync(JOURNAL, 'utf-8');
    const host = new FakeHost();
    const answer = await serviceFor(db, host).post({ jobId: 'job-r2-2-0001', to: 'file' });
    expect(answer).toMatchObject({ status: 409, body: { success: false, jobId: 'job-r2-2-early' } });
    expect(answer.body.error).toBe(`can't confirm; the meta of smdb_superseded_1 could not be read: relation "smdb_superseded_1.meta" does not exist`);
    expect(fs.readFileSync(JOURNAL, 'utf-8')).toBe(before);
    expect(host.lock).toBeNull();
  });

  it('an answer that would be neither is case 4, naming the schema and its error', async () => {
    const db = new FakeDb();
    earlierToFile(db, 'src-r2-2b');
    db.schemas.delete('smdb_data');
    unreadable(db, 'smdb_superseded_2');
    const answer = await serviceFor(db, new FakeHost()).post({ jobId: 'job-r2-2-0002', to: 'file' });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe(`can't confirm; the meta of smdb_superseded_2 could not be read: relation "smdb_superseded_2.meta" does not exist`);
    expect(answer.body.error).not.toMatch(/neither/);
  });

  it('a readable schema that gives case 2 still wins over an unreadable one', async () => {
    const db = new FakeDb();
    earlierToFile(db, 'src-r2-2c');
    const source = db.schemas.get('smdb_data')!;
    db.schemas.delete('smdb_data');
    db.schemas.set('smdb_superseded_3', source);
    unreadable(db, 'smdb_superseded_4');
    const answer = await serviceFor(db, new FakeHost()).post({ jobId: 'job-r2-2-0003', to: 'file' });
    expect(answer.body, why(answer.body)).toMatchObject({ success: true, jobId: 'job-r2-2-early', state: 'done' });
    expect(readJson(MARKER)).toMatchObject({ live: 'file', migration: 'job-r2-2-early' });
  });
});

describe('NB3-R2-3: only a pg DatabaseError counts as the database refusing the COMMIT', () => {
  const run = async (error: Error, jobId: string) => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    const db = new FakeDb();
    db.fail = sql => (/^COMMIT/.test(sql) ? error : undefined);
    const host = new FakeHost();
    const service = serviceFor(db, host);
    await service.post({ jobId, to: 'postgres' });
    await service.idle();
    return { db, host, job: service.status().body.job };
  };

  it('a socket error at the COMMIT (EPIPE) is interrupted: can\'t confirm whether the COMMIT landed', async () => {
    const { job, host } = await run(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), 'job-r2-3-0001');
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL)).toMatchObject({ result: 'interrupted', error: "can't confirm whether the COMMIT landed: write EPIPE" });
    expect(host.lock).toBeNull();
  });

  it('another five-letter Node code with no severity (EBADF) is interrupted too', async () => {
    const { job } = await run(Object.assign(new Error('bad file descriptor'), { code: 'EBADF' }), 'job-r2-3-0002');
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL).error).toBe("can't confirm whether the COMMIT landed: bad file descriptor");
  });

  it('a DatabaseError with a severity and a SQLSTATE is the database refusing the COMMIT: failed at rereading', async () => {
    const { job } = await run(Object.assign(new Error('could not serialize access'), { code: '40001', severity: 'ERROR' }), 'job-r2-3-0003');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading', error: 'The database refused the COMMIT: could not serialize access' });
  });

  it('after an interrupted COMMIT the next POST is classified by fact and runs', async () => {
    const { db } = await run(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), 'job-r2-3-0004');
    db.fail = null;
    const service = serviceFor(db, new FakeHost());
    const answer = await service.post({ jobId: 'job-r2-3-0005', to: 'postgres' });
    expect(answer.body, why(answer.body)).toMatchObject({ jobId: 'job-r2-3-0005', state: 'started' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ jobId: 'job-r2-3-0005', state: 'done' });
  });
});

describe('NB3-R2-4: a graveyard key under .graveyard.json refuses at reading', () => {
  it('names the key, for the exact and the case-folded folder', () => {
    expect(() => snapshotFromPgRows([], [], [graveRow('1700000000000', '.graveyard.json', 'x')]))
      .toThrow(`The key .graveyard.json/x of graveyard entry ${G1}-1700000000000 would take the place of its note; nothing was written`);
    expect(() => snapshotFromPgRows([], [], [graveRow('1700000000000', '.GRAVEYARD.JSON', 'x')]))
      .toThrow(`The key .GRAVEYARD.JSON/x of graveyard entry ${G1}-1700000000000 would take the place of its note`);
    expect(() => snapshotFromPgRows([], [], [graveRow('1700000000000', '', '.Graveyard.Json')])).toThrow(/would take the place of its note/);
  });

  it('a live guild holding a folder of that name refuses too (NB12 rule K: the retire would write its note there)', () => {
    expect(() => snapshotFromPgRows([{ guild_id: G1, module: '.graveyard.json', filename: 'x', doc: '{}' }], [], []))
      .toThrow(`The key .graveyard.json/x of guild ${G1}: it starts with ".graveyard.json"`);
  });

  it('the job fails at reading with no staging folder and the source unchanged', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r2-4', [graveRow('1700000000000'), graveRow('1700000000000', '.graveyard.json', 'x')]);
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-r2-4-0001', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job.error).toContain('The key .graveyard.json/x');
    expect(migrateFolders()).toEqual([]);
    expect(db.schemas.get('smdb_data')?.storeId).toBe('src-r2-4');
  });
});

describe('NB3-R2-OPS-3: a job statement with no byte from the database for the bound', () => {
  const streamed = (query: (sql: string) => Promise<any>) => {
    const stream = Object.assign(new EventEmitter(), { destroyed: 0, destroy() { this.destroyed += 1; } });
    return { session: { query, end: async () => undefined, connection: { stream } } as unknown as PgSession, stream };
  };

  it('rejects the statement, naming its kind, and destroys the socket', async () => {
    const { session, stream } = streamed(() => never());
    const watched = watchSession(session, 50);
    await expect(watched.query('SELECT 1')).rejects.toThrow('The SELECT got no answer from the database within 0.05 s');
    expect(stream.destroyed).toBe(1);
    const lock = watchSession(streamed(() => never()).session, 30);
    await expect(lock.query('LOCK TABLE smdb_data.meta IN SHARE MODE')).rejects.toThrow('The LOCK TABLE got no answer');
  });

  it('bytes from the database keep a long statement alive', async () => {
    const { session, stream } = streamed(() => new Promise(resolve => { setTimeout(() => resolve({ rows: [{ ok: 1 }] }), 200); }));
    const ticker = setInterval(() => stream.emit('data', Buffer.from('x')), 20);
    try {
      await expect(watchSession(session, 60).query('SELECT big')).resolves.toEqual({ rows: [{ ok: 1 }] });
    } finally { clearInterval(ticker); }
    expect(stream.destroyed).toBe(0);
  });

  it('the COMMIT is left to its own bound', async () => {
    const { session, stream } = streamed(() => never());
    const watched = watchSession(session, 20);
    let settled = false;
    void watched.query('COMMIT').then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => { setTimeout(resolve, 100); });
    expect(settled).toBe(false);
    expect(stream.destroyed).toBe(0);
  });

  it('to Postgres: an INSERT with no answer fails the job at copying, destroys the socket and releases the lock', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    const db = new FakeDb();
    const host = new FakeHost();
    const rec = recording(db, sql => (/^INSERT INTO smdb_data\.guild_data /.test(sql) ? never() : undefined));
    const service = serviceFor(db, host, { connect: rec.connect, answerBoundMs: 100, closeBoundMs: 50 });
    await service.post({ jobId: 'job-r2-op3-001', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying', error: 'The INSERT got no answer from the database within 0.1 s' });
    expect(rec.destroyed).toContain('smdb-migrate:job-r2-op3-001');
    expect(host.lock).toBeNull();
    expect(readJson(MARKER).live).toBe('file');
    expect(db.schemas.has('smdb_data')).toBe(false);
  });

  it('to JSON: a guild read with no answer fails the job at reading', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r2-op3');
    const rec = recording(db, sql => (/FROM smdb_data\.guild_data WHERE guild_id = \$1/.test(sql) ? never() : undefined));
    const service = serviceFor(db, new FakeHost(), { connect: rec.connect, answerBoundMs: 100, closeBoundMs: 50 });
    await service.post({ jobId: 'job-r2-op3-002', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading', error: 'The SELECT got no answer from the database within 0.1 s' });
    expect(readJson(MARKER).live).toBe('postgres');
  });

  it('the COMMIT keeps its own bound and its interrupted result', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    const db = new FakeDb();
    const rec = recording(db, sql => (sql === 'COMMIT' ? never() : undefined));
    const service = serviceFor(db, new FakeHost(), { connect: rec.connect, answerBoundMs: 30, commitBoundMs: 200, closeBoundMs: 50 });
    await service.post({ jobId: 'job-r2-op3-003', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL).error).toMatch(/^The COMMIT got no answer within/);
  });
});

describe("NB3-R2-OPS-4: an earlier job's database session still open", () => {
  const earlierToPg = (stage: string, extra: Record<string, unknown> = {}) => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    writeJson(JOURNAL, { jobId: 'job-r2-op4-old', to: 'postgres', stage, result: 'failed', error: 'x', startedAt: 1, finishedAt: 2, destination: normalizeAddress(PG_URL), ...extra });
  };
  const OPEN = `migration job-r2-op4-old's database session is still open; ${NEXT_STEP}`;

  it('a move to Postgres that ended after S4 is case 4 while its session is open; the journal stays and the lock is released', async () => {
    earlierToPg('rereading');
    const db = new FakeDb();
    db.sessions.push('smdb-migrate:job-r2-op4-old');
    const before = fs.readFileSync(JOURNAL, 'utf-8');
    const host = new FakeHost();
    const service = serviceFor(db, host);
    const answer = await service.post({ jobId: 'job-r2-op4-new1', to: 'postgres' });
    expect(answer).toMatchObject({ status: 409, body: { success: false, error: `can't confirm; ${OPEN}`, jobId: 'job-r2-op4-old' } });
    expect(fs.readFileSync(JOURNAL, 'utf-8')).toBe(before);
    expect(host.lock).toBeNull();
    db.sessions.splice(db.sessions.indexOf('smdb-migrate:job-r2-op4-old'), 1);
    const again = await service.post({ jobId: 'job-r2-op4-new2', to: 'postgres' });
    expect(again.body, why(again.body)).toMatchObject({ state: 'started' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ jobId: 'job-r2-op4-new2', state: 'done' });
  });

  it('an interrupted COMMIT counts the same', async () => {
    earlierToPg('committing', { result: 'interrupted' });
    const db = new FakeDb();
    db.sessions.push('smdb-migrate:job-r2-op4-old');
    const answer = await serviceFor(db, new FakeHost()).post({ jobId: 'job-r2-op4-new3', to: 'postgres' });
    expect(answer.body.error).toBe(`can't confirm; ${OPEN}`);
  });

  it('S2 names an smdb-migrate session with the same next step, beside the other sessions', async () => {
    earlierToPg('reading');
    const db = new FakeDb();
    db.sessions.push('smdb-migrate:job-r2-op4-old');
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-r2-op4-new4', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'failed', stage: 'checking', error: `Migration job-r2-op4-old's database session is still open; ${NEXT_STEP}` });

    earlierToPg('reading');
    db.sessions.push('other-bot');
    const mixed = serviceFor(db, new FakeHost());
    await mixed.post({ jobId: 'job-r2-op4-new5', to: 'postgres' });
    await mixed.idle();
    expect(mixed.status().body.job.error).toBe(`1 other session(s) or worker(s) are connected to this database (other-bot: 1); stop every bot and every other client of this database first. Migration job-r2-op4-old's database session is still open; ${NEXT_STEP}`);
  });

  it('an earlier job on another database is not read for', async () => {
    earlierToPg('rereading', { destination: { host: 'elsewhere.example', port: 5432, database: 'smdb' } });
    const db = new FakeDb();
    const rec = recording(db);
    const service = serviceFor(db, new FakeHost(), { connect: rec.connect });
    const answer = await service.post({ jobId: 'job-r2-op4-new6', to: 'postgres' });
    expect(answer.body.state).toBe('started');
    await service.idle();
    expect(rec.seen.filter(s => s.app === 'smdb-migrate:job-r2-op4-new6' && /application_name = \$1/.test(s.sql))).toEqual([]);
  });
});

describe("NB3-R2-OPS-6: S0's read and the finishing path name the address and its source", () => {
  const earlierToFile = (db: FakeDb) => {
    pgSource(db, 'src-r2-op6');
    writeJson(JOURNAL, { jobId: 'job-r2-op6-old', to: 'file', stage: 'retire-source', sourceStoreId: 'src-r2-op6', startedAt: 1 });
  };

  it('a database S0 cannot read is named by host, port and database, and DATA_BACKEND_URL, without credentials', async () => {
    const db = new FakeDb();
    earlierToFile(db);
    db.unreachable = true;
    const answer = await serviceFor(db, new FakeHost()).post({ jobId: 'job-r2-op6-001', to: 'file' });
    expect(answer.body.error).toBe("can't confirm; the database at db.example:5432/smdb (from DATA_BACKEND_URL) could not be read: connect ECONNREFUSED");
    expect(answer.body.error).not.toMatch(/pw|bot:/);
    db.unreachable = false;
    db.refuseLogin = true;
    const login = await serviceFor(db, new FakeHost()).post({ jobId: 'job-r2-op6-002', to: 'file' });
    expect(login.body.error).toBe("The database refused the bot's login at db.example:5432/smdb (from DATA_BACKEND_URL)");
  });

  const doneToPg = (finishedAt: number, extra: Record<string, unknown> = {}) => {
    freshJsonBot();
    writeJson(MARKER, { live: 'postgres', storeId: 'copy-r2', flippedAt: 1, migration: 'job-r2-fin-old' });
    writeJson(JOURNAL, {
      jobId: 'job-r2-fin-old', to: 'postgres', stage: 'env', result: 'done', startedAt: 1, finishedAt, storeId: 'copy-r2',
      destination: normalizeAddress(PG_URL), envSwitched: true, ...extra,
    });
  };

  it('the finishing path says DATA_BACKEND_URL is not set, or cannot be parsed', async () => {
    doneToPg(5);
    delete process.env.DATA_BACKEND_URL;
    const unset = await serviceFor(new FakeDb(), new FakeHost()).post({ jobId: 'job-r2-op6-003', to: 'postgres' });
    expect(unset.body.error).toBe("can't confirm; migration job-r2-fin-old copied to db.example:5432/smdb (store copy-r2), and DATA_BACKEND_URL is not set");
    process.env.DATA_BACKEND_URL = 'nonsense';
    const bad = await serviceFor(new FakeDb(), new FakeHost()).post({ jobId: 'job-r2-op6-004', to: 'postgres' });
    expect(bad.body.error).toBe("can't confirm; migration job-r2-fin-old copied to db.example:5432/smdb (store copy-r2), and DATA_BACKEND_URL cannot be parsed as a database address");
  });

  it('a managed request names the address given in the request', async () => {
    doneToPg(5);
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'tok';
    const answer = await serviceFor(new FakeDb(), new FakeHost()).post({ jobId: 'job-r2-op6-005', to: 'postgres', url: 'postgres://u:secret@Other.Example/smdb' });
    expect(answer.body.error).toBe("can't confirm; migration job-r2-fin-old copied to db.example:5432/smdb (store copy-r2), not other.example:5432/smdb (from the destination address given in the request)");
    expect(answer.body.error).not.toMatch(/secret/);
  });
});

describe('NB3-R2-OPS-1: finish() keeps a done journal\'s finishedAt', () => {
  const doneToPg = (extra: Record<string, unknown> = {}) => {
    freshJsonBot();
    writeJson(MARKER, { live: 'postgres', storeId: 'copy-r2', flippedAt: 1, migration: 'job-r2-fin-old' });
    writeJson(JOURNAL, {
      jobId: 'job-r2-fin-old', to: 'postgres', stage: 'env', result: 'done', startedAt: 1, finishedAt: 12345, storeId: 'copy-r2',
      destination: normalizeAddress(PG_URL), envSwitched: true, ...extra,
    });
  };

  it('a POST answered done from a done journal leaves the journal as it was', async () => {
    doneToPg();
    fs.writeFileSync(ENV, 'DATA_BACKEND=postgres\n');
    const before = fs.readFileSync(JOURNAL, 'utf-8');
    const answer = await serviceFor(new FakeDb(), new FakeHost()).post({ jobId: 'job-r2-op1-001', to: 'postgres' });
    expect(answer.body, why(answer.body)).toMatchObject({ success: true, jobId: 'job-r2-fin-old', state: 'done' });
    expect(fs.readFileSync(JOURNAL, 'utf-8')).toBe(before);
  });

  it('a done journal whose env is written again keeps its finishedAt', async () => {
    doneToPg();
    fs.writeFileSync(ENV, 'DATA_BACKEND=file\n');
    const answer = await serviceFor(new FakeDb(), new FakeHost()).post({ jobId: 'job-r2-op1-002', to: 'postgres' });
    expect(answer.body.state).toBe('done');
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=postgres\n');
    expect(readJson(JOURNAL)).toMatchObject({ result: 'done', finishedAt: 12345 });
  });

  it('a journal that was not done gets the time it is finished at', async () => {
    doneToPg({ result: 'interrupted' });
    fs.writeFileSync(ENV, 'DATA_BACKEND=file\n');
    const before = Date.now();
    await serviceFor(new FakeDb(), new FakeHost()).post({ jobId: 'job-r2-op1-003', to: 'postgres' });
    expect(readJson(JOURNAL).result).toBe('done');
    expect(readJson(JOURNAL).finishedAt).toBeGreaterThanOrEqual(before);
  });
});
