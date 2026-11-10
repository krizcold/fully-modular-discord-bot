import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  insertRows, jobSessionSettings, MAX_BATCH_BYTES, normalizeAddress, probeBackend, statementBytes, watchSession, type PgSession,
} from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 code review rounds 3 and 4: R3-1 and R4-T3/T4 (a COMMIT error is a refusal only from a session that still
// answers), R3-2 (every ROLLBACK is watched), R3-3 (an unreadable store id), R3-4 and R4-RUN-3/RUN-4/T2 (two-way
// progress, the bound by size, the probe by pid and start, the 16 MB batch cap, the stream read-back guild by guild)
// and R3-5 with R4-T1 (the best-effort session settings and the one session text).

const G1 = '890000000000000001';
const G2 = '890000000000000002';
const ONCE_GONE = 'the database ends it once it notices the connection is gone; run the migration again once it no longer shows';

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

const never = () => new Promise<never>(() => undefined);
const later = <T>(ms: number, work: () => Promise<T>) => new Promise<T>((resolve, reject) => { setTimeout(() => { work().then(resolve, reject); }, ms); });
const dbError = (code: string, severity: string, text: string) => Object.assign(new Error(text), { code, severity });

type Seen = { app: string; sql: string; params: any[]; n: number };

/** The fake's client per session: n numbers the job sessions from 0 (-1 for a probe); each socket's destroy is recorded. */
function recording(db: FakeDb, override?: (sql: string, n: number, pass: () => Promise<any>) => Promise<any> | undefined) {
  const destroyed: number[] = [];
  const seen: Seen[] = [];
  const pids: number[] = [];
  const starts: string[] = [];
  let jobs = 0;
  let probes = 0;
  const connect = async (_url: string, app: string, kind: 'job' | 'probe'): Promise<PgSession> => {
    const client = db.connect(app);
    const n = kind === 'job' ? jobs++ : -1;
    if (kind === 'probe') probes += 1;
    if (n >= 0) {
      pids[n] = client.pid;
      starts[n] = client.started;
    }
    const stream = Object.assign(new EventEmitter(), { bytesWritten: 0, writableLength: 0, destroy: () => { destroyed.push(n); void client.end(); } });
    const session = {
      query: (text: string, params: any[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        seen.push({ app, sql, params, n });
        return override?.(sql, n, () => client.query(text, params)) ?? client.query(text, params);
      },
      end: () => client.end(),
      connection: { stream },
    };
    return session as unknown as PgSession;
  };
  const asked = () => seen.filter(s => s.n === -1 && /^SELECT state, wait_event_type FROM pg_stat_activity/.test(s.sql)).map(s => s.params);
  return { connect, destroyed, seen, pids, starts, asked, probes: () => probes };
}

function pgSource(db: FakeDb, storeId: string): void {
  writeJson(MARKER, { live: 'postgres', storeId, flippedAt: 1 });
  db.schemas.set('smdb_data', {
    ...emptyStore(storeId),
    data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }, { guild_id: G2, module: 'm', filename: 'b.json', doc: '{"b":2}' }],
  });
}

function jsonSource(): void {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"a":1}');
}

async function runJob(db: FakeDb, jobId: string, to: 'file' | 'postgres', extra: Parameters<typeof serviceFor>[2] = {}) {
  const host = new FakeHost();
  const service = serviceFor(db, host, extra);
  const answer = await service.post({ jobId, to });
  await service.idle();
  return { answer, host, job: service.status().body.job };
}

/** A session whose socket is an EventEmitter with the write counters of a net.Socket. */
function streamed(query: (sql: string) => Promise<any>) {
  const stream = Object.assign(new EventEmitter(), { destroyed: 0, bytesWritten: 0, writableLength: 0, destroy() { this.destroyed += 1; } });
  return { session: { query, end: async () => undefined, connection: { stream } } as unknown as PgSession, stream };
}

describe('NB3-R3-1 and NB3-R4-T3/T4: a DatabaseError at COMMIT is a refusal only when the session still answers SELECT 1', () => {
  const panic = () => dbError('58030', 'PANIC', 'could not fsync file "pg_wal/000000010000000000000001": Input/output error');
  const lost = () => Promise.reject(new Error('Connection terminated unexpectedly'));
  /** A PANIC or FATAL ends the session, so its SELECT 1 is refused. */
  const ended = (db: FakeDb, error: () => Error) => recording(db, sql => (sql === 'COMMIT' ? Promise.reject(error()) : sql === 'SELECT 1' ? lost() : undefined));

  it('to Postgres: a PANIC at the COMMIT is interrupted at committing', async () => {
    jsonSource();
    const db = new FakeDb();
    const rec = ended(db, panic);
    const { job, host } = await runJob(db, 'job-r3-1-0001', 'postgres', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL).error).toBe(`can't confirm whether the COMMIT landed: ${panic().message}`);
    expect(host.lock).toBeNull();
  });

  it('to JSON: a PANIC at the retire COMMIT is interrupted at retire-source', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r3-1');
    const rec = ended(db, panic);
    const { job } = await runJob(db, 'job-r3-1-0002', 'file', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'retire-source' });
    expect(readJson(JOURNAL).error).toMatch(/^can't confirm whether the COMMIT landed: could not fsync file/);
  });

  it('a FATAL is interrupted too', async () => {
    jsonSource();
    const db = new FakeDb();
    const rec = ended(db, () => dbError('57P01', 'FATAL', 'terminating connection due to administrator command'));
    const { job } = await runJob(db, 'job-r3-1-0003', 'postgres', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL).error).toBe("can't confirm whether the COMMIT landed: terminating connection due to administrator command");
  });

  it('R4-T4: an ERROR whose SELECT 1 is refused afterwards is interrupted at committing', async () => {
    jsonSource();
    const db = new FakeDb();
    const rec = ended(db, () => dbError('40001', 'ERROR', 'could not serialize access'));
    const { job, host } = await runJob(db, 'job-r4-t4-0001', 'postgres', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL).error).toBe("can't confirm whether the COMMIT landed: could not serialize access");
    expect(host.lock).toBeNull();
  });

  it('R4-T3: a refusal whose severity text is localized is a refusal when SELECT 1 answers: failed at rereading', async () => {
    jsonSource();
    const db = new FakeDb();
    const rec = recording(db, sql => (sql === 'COMMIT' ? Promise.reject(dbError('40001', 'FEHLER', 'konnte Zugriff nicht serialisieren')) : undefined));
    const { job, host } = await runJob(db, 'job-r4-t3-0001', 'postgres', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading', error: 'The database refused the COMMIT: konnte Zugriff nicht serialisieren' });
    expect(host.lock).toBeNull();
    expect(db.schemas.has('smdb_data')).toBe(false);
  });

  it.each([
    ['57P01 with a localized severity', 'ВАЖНО', '57P01'],
    ['XX000 at ERROR', 'ERROR', 'XX000'],
  ])('a COMMIT failing with %s is interrupted at committing, even when SELECT 1 answers', async (_name, severity, code) => {
    jsonSource();
    const db = new FakeDb();
    const rec = recording(db, sql => (sql === 'COMMIT' ? Promise.reject(dbError(code, severity, 'the COMMIT ended')) : undefined));
    const { job, host } = await runJob(db, `job-nb13-f1-${code}`, 'postgres', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL).error).toBe("can't confirm whether the COMMIT landed: the COMMIT ended");
    expect(host.lock).toBeNull();
  });

  it('a COMMIT answered 23505 at ERROR on a session that answers SELECT 1 is the refusal: failed at rereading', async () => {
    jsonSource();
    const db = new FakeDb();
    const rec = recording(db, sql => (sql === 'COMMIT' ? Promise.reject(dbError('23505', 'ERROR', 'duplicate key value')) : undefined));
    const { job } = await runJob(db, 'job-nb13-f1-23505', 'postgres', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading', error: 'The database refused the COMMIT: duplicate key value' });
  });

  it('an ERROR on a session that does not answer SELECT 1 within the close bound is interrupted, and the socket is destroyed', async () => {
    jsonSource();
    const db = new FakeDb();
    const rec = recording(db, sql => {
      if (sql === 'COMMIT') return Promise.reject(dbError('40001', 'ERROR', 'could not serialize access'));
      if (sql === 'SELECT 1') return never();
      return undefined;
    });
    const { job, host } = await runJob(db, 'job-r3-1-0004', 'postgres', { connect: rec.connect, closeBoundMs: 50 });
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL).error).toBe("can't confirm whether the COMMIT landed: could not serialize access");
    expect(rec.destroyed).toContain(0);
    expect(host.lock).toBeNull();
  });

  it('an ERROR on a session that answers SELECT 1 is the refusal: failed at rereading', async () => {
    jsonSource();
    const db = new FakeDb();
    db.fail = sql => (/^COMMIT/.test(sql) ? dbError('40001', 'ERROR', 'could not serialize access') : undefined);
    const rec = recording(db);
    const { job } = await runJob(db, 'job-r3-1-0005', 'postgres', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading', error: 'The database refused the COMMIT: could not serialize access' });
    const main = rec.seen.filter(s => s.n === 0).map(s => s.sql);
    expect(main.slice(main.indexOf('COMMIT') + 1)).toContain('SELECT 1');
  });
});

describe('NB3-R3-2: every ROLLBACK is watched; only COMMIT is exempt', () => {
  it('a ROLLBACK with no answer is ended at the bound and its socket destroyed', async () => {
    const { session, stream } = streamed(() => never());
    await expect(watchSession(session, 30).query('ROLLBACK')).rejects.toThrow('The ROLLBACK got no answer from the database within 0.03 s');
    expect(stream.destroyed).toBe(1);
  });

  it("to JSON: the S7 session's ROLLBACK with no answer ends the job and releases the lock", async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r3-2');
    const rec = recording(db, (sql, n) => (n === 1 && sql === 'ROLLBACK' ? never() : undefined));
    db.backendState = pid => (pid === rec.pids[1] ? { state: 'idle', wait_event_type: 'Client' } : { state: 'active', wait_event_type: 'IO' });
    const started = Date.now();
    const { job, host } = await runJob(db, 'job-r3-2-0001', 'file', { connect: rec.connect, answerBoundMs: 100, closeBoundMs: 50 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading', error: 'The ROLLBACK got no answer from the database within 0.1 s' });
    expect(rec.asked()).toEqual([[rec.pids[1], rec.starts[1]]]);
    expect(rec.destroyed).toContain(1);
    expect(host.lock).toBeNull();
    expect(readJson(MARKER).live).toBe('postgres');
    expect(db.schemas.get('smdb_data')?.storeId).toBe('src-r3-2');
  }, 5000);
});

describe("NB3-R3-3: only 42P01 and 3F000 read as no store at S2", () => {
  const denied = () => dbError('42501', 'ERROR', 'permission denied for table meta');
  const metaRead = (sql: string) => /^SELECT value FROM "?smdb_data"?\.meta WHERE key = 'store_id'/.test(sql);
  const CANT = "can't confirm the store id of smdb_data at db.example:5432/smdb: ";

  it('to JSON: a refused store id read fails at checking and names the read, not a store', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r3-3');
    db.fail = sql => (metaRead(sql) ? denied() : undefined);
    const { job } = await runJob(db, 'job-r3-3-0001', 'file');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: `${CANT}permission denied for table meta` });
    expect(job.error).not.toMatch(/holds store/);
  });

  it('to JSON: a store id read with no answer fails the same way', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r3-3b');
    const rec = recording(db, sql => (metaRead(sql) ? never() : undefined));
    const { job } = await runJob(db, 'job-r3-3-0002', 'file', { connect: rec.connect, answerBoundMs: 80, closeBoundMs: 50 });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: `${CANT}The SELECT got no answer from the database within 0.08 s` });
  });

  it('to Postgres: a refused store id read of a present smdb_data fails at checking, naming the read', async () => {
    jsonSource();
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('dest-r3-3'));
    db.fail = sql => (metaRead(sql) ? denied() : undefined);
    const { job } = await runJob(db, 'job-r3-3-0003', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: `${CANT}permission denied for table meta` });
    expect(job.error).not.toMatch(/already holds store/);
  });

  it('to Postgres: a missing meta table (42P01) still reads as a store with no id', async () => {
    jsonSource();
    const db = new FakeDb();
    db.schemas.set('smdb_data', { ...emptyStore(null), noMeta: true });
    const { job } = await runJob(db, 'job-r3-3-0004', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toMatch(/^The database already holds store with no id in schema smdb_data/);
  });
});

describe('NB3-R3-4: the watchdog counts progress both ways and asks the database before it destroys', () => {
  it('bytes handed to the kernel keep a statement alive', async () => {
    const { session, stream } = streamed(() => new Promise(resolve => { setTimeout(() => resolve({ rows: [{ ok: 1 }] }), 250); }));
    const ticker = setInterval(() => { stream.bytesWritten += 65536; }, 15);
    try {
      await expect(watchSession(session, 60).query('INSERT INTO smdb_data.guild_append VALUES (1)')).resolves.toEqual({ rows: [{ ok: 1 }] });
    } finally { clearInterval(ticker); }
    expect(stream.destroyed).toBe(0);
  });

  it('bytes still queued in the process are not progress', async () => {
    const { session, stream } = streamed(() => never());
    const ticker = setInterval(() => { stream.bytesWritten += 65536; stream.writableLength += 65536; }, 10);
    try {
      await expect(watchSession(session, 60).query('INSERT INTO smdb_data.guild_append VALUES (1)')).rejects.toThrow('The INSERT got no answer from the database within 0.06 s');
    } finally { clearInterval(ticker); }
    expect(stream.destroyed).toBe(1);
  });

  it('a backend the probe finds busy keeps its statement, asked again at each bound', async () => {
    const { session, stream } = streamed(() => new Promise(resolve => { setTimeout(() => resolve({ rows: [] }), 250); }));
    let asked = 0;
    const watched = watchSession(session, 40, async () => { asked += 1; return true; });
    await expect(watched.query('SELECT big')).resolves.toEqual({ rows: [] });
    expect(asked).toBeGreaterThanOrEqual(2);
    expect(stream.destroyed).toBe(0);
  });

  it('a backend the probe finds not busy, or a probe that fails, ends the statement', async () => {
    for (const busy of [async () => false, async () => { throw new Error('connect ETIMEDOUT'); }]) {
      const { session, stream } = streamed(() => never());
      await expect(watchSession(session, 30, busy).query('SELECT big')).rejects.toThrow('The SELECT got no answer from the database within 0.03 s');
      expect(stream.destroyed).toBe(1);
    }
  });

  it('the probe answers busy only for an active backend that does not wait on the client, asking by pid and start', async () => {
    const params: unknown[][] = [];
    const answering = (rows: any[]) => async () => ({ query: async (_sql: string, p: unknown[] = []) => { params.push(p); return { rows }; }, end: async () => undefined } as PgSession);
    const job = { pid: 7, started: '1800000000000007' };
    expect(await probeBackend(answering([{ state: 'active', wait_event_type: 'IO' }]), job, 200)).toBe(true);
    expect(await probeBackend(answering([{ state: 'active', wait_event_type: null }]), job, 200)).toBe(true);
    expect(await probeBackend(answering([{ state: 'active', wait_event_type: 'Lock' }]), job, 200)).toBe(true);
    expect(await probeBackend(answering([{ state: 'active', wait_event_type: 'Client' }]), job, 200)).toBe(false);
    expect(await probeBackend(answering([{ state: 'idle', wait_event_type: 'Client' }]), job, 200)).toBe(false);
    expect(await probeBackend(answering([{ state: 'idle in transaction', wait_event_type: 'Client' }]), job, 200)).toBe(false);
    expect(await probeBackend(answering([]), job, 200)).toBe(false);
    expect(params).toEqual(Array(7).fill([7, '1800000000000007']));
    expect(await probeBackend(async () => { throw new Error('connect ECONNREFUSED'); }, job, 200)).toBe(false);
    let opened = false;
    expect(await probeBackend(async () => { opened = true; return answering([])(); }, { pid: null, started: null }, 200)).toBe(false);
    expect(await probeBackend(async () => { opened = true; return answering([])(); }, { pid: 7, started: null }, 200)).toBe(false);
    expect(opened).toBe(false);
  });

  it('R4-RUN-4: a backend with the same pid and another backend_start reads as gone', async () => {
    const db = new FakeDb();
    db.backendState = () => ({ state: 'active', wait_event_type: 'IO' });
    const client = db.connect('smdb-migrate:job-r4-run4');
    const job = await jobSessionSettings(client as unknown as PgSession);
    expect(job).toMatchObject({ pid: client.pid, started: client.started });
    const open = async () => db.connect('smdb-migrate:job-r4-run4') as unknown as PgSession;
    expect(await probeBackend(open, job, 200)).toBe(true);
    client.started = '1800000000009999';
    expect(await probeBackend(open, job, 200)).toBe(false);
  });

  it('R4-RUN-3: a large statement gets 1 s more per MB it sends before it is ended', async () => {
    const { session, stream } = streamed(() => never());
    const started = Date.now();
    await expect(watchSession(session, 50).query('INSERT INTO t VALUES ($1)', [['x'.repeat(512 * 1024)]]))
      .rejects.toThrow('The INSERT got no answer from the database within 0.55 s');
    expect(Date.now() - started).toBeGreaterThanOrEqual(490);
    expect(stream.destroyed).toBe(1);
  });

  it('R5-T1: a text[] element counts as pg writes it, quotes and escapes included', async () => {
    const { session, stream } = streamed(() => never());
    const started = Date.now();
    await expect(watchSession(session, 50).query('INSERT INTO t VALUES ($1)', [['"'.repeat(512 * 1024)]]))
      .rejects.toThrow('The INSERT got no answer from the database within 1.05 s');
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    expect(stream.destroyed).toBe(1);
  });

  it('R5-T1: a Buffer element counts as its hex form and a null element as NULL', async () => {
    const { session } = streamed(() => never());
    await expect(watchSession(session, 50).query('INSERT INTO t VALUES ($1)', [[Buffer.alloc(128 * 1024), ...new Array(128 * 1024).fill(null)]]))
      .rejects.toThrow('The INSERT got no answer from the database within 0.925 s');
  });

  it('R6-1: an array counts one comma between each pair of elements, not one per element', async () => {
    const { session } = streamed(() => never());
    await expect(watchSession(session, 50).query('INSERT INTO t VALUES ($1)', [new Array(256 * 1024).fill('')]))
      .rejects.toThrow('The INSERT got no answer from the database within 0.8 s');
  });

  it('R4-RUN-3: the probe runs at the grown bound, not before', async () => {
    const { session } = streamed(() => never());
    let askedAt = -1;
    const started = Date.now();
    await expect(watchSession(session, 50, async () => { askedAt = Date.now() - started; return false; }).query('INSERT INTO t VALUES ($1)', [Buffer.alloc(300 * 1024)]))
      .rejects.toThrow('within 0.342 s');
    expect(askedAt).toBeGreaterThanOrEqual(280);
  });

  it('a probe that cannot connect within its bound answers not busy, and a late session is closed', async () => {
    let ended = false;
    const late = () => new Promise<PgSession>(resolve => {
      setTimeout(() => resolve({ query: async () => ({ rows: [{ state: 'active' }] }), end: async () => { ended = true; } } as PgSession), 1_000);
    });
    const started = Date.now();
    expect(await probeBackend(late, { pid: 7, started: '1' }, 30)).toBe(false);
    expect(Date.now() - started).toBeLessThan(800);
    const deadline = Date.now() + 5_000;
    while (!ended && Date.now() < deadline) await new Promise(r => setTimeout(r, 2));
    expect(ended).toBe(true);
  });

  it('to Postgres: an INSERT slower than the bound on a busy backend completes, and the job is done', async () => {
    jsonSource();
    const db = new FakeDb();
    const rec = recording(db, (sql, n, pass) => (n === 0 && /^INSERT INTO smdb_data\.guild_data /.test(sql) ? later(300, pass) : undefined));
    db.backendState = pid => (pid === rec.pids[0] ? { state: 'active', wait_event_type: 'IO' } : { state: 'idle', wait_event_type: 'Client' });
    const { job } = await runJob(db, 'job-r3-4-0001', 'postgres', { connect: rec.connect, answerBoundMs: 80, closeBoundMs: 50 });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(rec.probes()).toBeGreaterThanOrEqual(1);
    expect(rec.asked().length).toBeGreaterThanOrEqual(1);
    for (const p of rec.asked()) expect(p).toEqual([rec.pids[0], rec.starts[0]]);
    expect(rec.destroyed).toEqual([]);
    expect(db.schemas.get('smdb_data')?.data.map(r => r.guild_id)).toEqual([G1]);
  });

  it('the same INSERT on a backend waiting on the client fails at copying', async () => {
    jsonSource();
    const db = new FakeDb();
    db.backendState = () => ({ state: 'active', wait_event_type: 'Client' });
    const rec = recording(db, (sql, n) => (n === 0 && /^INSERT INTO smdb_data\.guild_data /.test(sql) ? never() : undefined));
    const { job, host } = await runJob(db, 'job-r3-4-0002', 'postgres', { connect: rec.connect, answerBoundMs: 80, closeBoundMs: 50 });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying', error: 'The INSERT got no answer from the database within 0.08 s' });
    expect(rec.probes()).toBeGreaterThanOrEqual(1);
    for (const p of rec.asked()) expect(p).toEqual([rec.pids[0], rec.starts[0]]);
    expect(rec.destroyed).toContain(0);
    expect(host.lock).toBeNull();
  });

  it('INSERT batches stop at 16 MB as well as at 500 rows', async () => {
    const batches: number[] = [];
    const session = { query: async (_sql: string, params: any[] = []) => { batches.push(params[0].length); return { rows: [] }; }, end: async () => undefined } as PgSession;
    const big = 'x'.repeat(6 * 1024 * 1024);
    await insertRows(session, 'INSERT', [['a', 'b', 'c'], [big, big, big]]);
    expect(batches).toEqual([2, 1]);
    batches.length = 0;
    const ids = Array.from({ length: 1201 }, (_, i) => String(i));
    await insertRows(session, 'INSERT', [ids, ids]);
    expect(batches).toEqual([500, 500, 201]);
    batches.length = 0;
    const huge = 'y'.repeat(MAX_BATCH_BYTES + 1);
    await insertRows(session, 'INSERT', [['a', 'b', 'c'], ['small', huge, 'small']]);
    expect(batches).toEqual([1, 1, 1]);
  });

  it("S6 reads the destination's streams back guild by guild", async () => {
    freshJsonBot();
    seedFile(`${G1}/m/s.jsonl`, '{"a":1}\n');
    seedFile(`${G2}/m/t.jsonl`, '{"b":2}\n{"c":3}\n');
    const db = new FakeDb();
    const rec = recording(db);
    const { job } = await runJob(db, 'job-r3-4-0003', 'postgres', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const reads = rec.seen.filter(s => /string_agg\(chunk/.test(s.sql));
    expect(reads.map(s => s.params)).toEqual([[G1], [G2]]);
    for (const r of reads) expect(r.sql).toMatch(/FROM smdb_data\.guild_append WHERE guild_id = \$1 GROUP BY/);
  });
});

describe('NB3-R3-5 and NB3-R4-T1: the best-effort session settings and the one session text', () => {
  const sets = (seen: Seen[], n: number) => seen.filter(s => s.n === n && /^SET /.test(s.sql)).map(s => s.sql);

  it('to JSON: both job sessions SET tcp_user_timeout and client_connection_check_interval on Postgres 14 and later', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r3-5');
    const rec = recording(db);
    const { job } = await runJob(db, 'job-r3-5-0001', 'file', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    for (const n of [0, 1]) expect(sets(rec.seen, n)).toEqual(['SET tcp_user_timeout = 60000', 'SET client_connection_check_interval = 10000']);
    expect(rec.seen.filter(s => s.n === -1 && /^SET /.test(s.sql))).toEqual([]);
  });

  it('Postgres 12 and 13 get tcp_user_timeout only, 11 neither; the version, pid and start are answered', async () => {
    for (const [version, want] of [[160000, 2], [140000, 2], [130000, 1], [120000, 1], [110000, 0]] as const) {
      const db = new FakeDb();
      db.serverVersion = version;
      const client = db.connect('t');
      const statements: string[] = [];
      const session = { query: (sql: string, p?: unknown[]) => { statements.push(sql); return client.query(sql, p as any[]); }, end: () => client.end() } as PgSession;
      const got = await jobSessionSettings(session);
      expect(got).toEqual({ version, pid: client.pid, started: client.started });
      expect(statements.filter(s => s.startsWith('SET '))).toEqual(['SET tcp_user_timeout = 60000', 'SET client_connection_check_interval = 10000'].slice(0, want));
    }
  });

  it('a refused SET is skipped and the next one is still sent; a lost connection is not skipped', async () => {
    const db = new FakeDb();
    db.fail = sql => (/^SET tcp_user_timeout/.test(sql) ? dbError('22023', 'ERROR', '"tcp_user_timeout" cannot be changed on this platform') : undefined);
    const client = db.connect('t');
    const statements: string[] = [];
    const session = { query: (sql: string, p?: unknown[]) => { statements.push(sql); return client.query(sql, p as any[]); }, end: () => client.end() } as PgSession;
    await expect(jobSessionSettings(session)).resolves.toMatchObject({ version: 160000, pid: client.pid });
    expect(statements.filter(s => s.startsWith('SET '))).toEqual(['SET tcp_user_timeout = 60000', 'SET client_connection_check_interval = 10000']);
    db.fail = sql => (/^SET tcp_user_timeout/.test(sql) ? new Error('Connection terminated unexpectedly') : undefined);
    await expect(jobSessionSettings(db.connect('t') as unknown as PgSession)).rejects.toThrow('Connection terminated unexpectedly');
  });

  it('R5-T2: a SET ended by 57P01 (FATAL) fails the job at checking with the server text; a 22023 is still skipped', async () => {
    const warn = vi.mocked(console.warn);
    const terminated = 'terminating connection due to administrator command';
    const db = new FakeDb();
    db.fail = sql => (/^SET tcp_user_timeout/.test(sql) ? dbError('57P01', 'FATAL', terminated) : undefined);
    await expect(jobSessionSettings(db.connect('t') as unknown as PgSession)).rejects.toThrow(terminated);
    jsonSource();
    const { job, host } = await runJob(db, 'job-r5-t2-0001', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toContain(terminated);
    expect(host.lock).toBeNull();
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/goes on without it/);
    db.fail = sql => (/^SET tcp_user_timeout/.test(sql) ? dbError('22023', 'ERROR', '"tcp_user_timeout" cannot be changed on this platform') : undefined);
    await expect(jobSessionSettings(db.connect('t') as unknown as PgSession)).resolves.toMatchObject({ version: 160000 });
    expect(warn.mock.calls.flat().join('\n')).toMatch(/refused "SET tcp_user_timeout = 60000"; the migration goes on without it/);
  });

  it('R6-2: each SQLSTATE of a refused setting is skipped; 22P02 and a FATAL 57P01 are not', async () => {
    const warn = vi.mocked(console.warn);
    for (const code of ['42704', '0A000', '55P02', '42501']) {
      warn.mockClear();
      const db = new FakeDb();
      db.fail = sql => (/^SET client_connection_check_interval/.test(sql) ? dbError(code, 'ERROR', `refused with ${code}`) : undefined);
      await expect(jobSessionSettings(db.connect('t') as unknown as PgSession), code).resolves.toMatchObject({ version: 160000 });
      expect(warn.mock.calls.flat().join('\n'), code).toMatch(/refused "SET client_connection_check_interval = 10000"; the migration goes on without it/);
    }
    for (const [code, severity] of [['22P02', 'ERROR'], ['57P01', 'FATAL']]) {
      const db = new FakeDb();
      db.fail = sql => (/^SET client_connection_check_interval/.test(sql) ? dbError(code, severity, `refused with ${code}`) : undefined);
      await expect(jobSessionSettings(db.connect('t') as unknown as PgSession), code).rejects.toThrow(`refused with ${code}`);
    }
  });

  for (const to of ['postgres', 'file'] as const) {
    it(`to ${to === 'file' ? 'JSON' : 'Postgres'}: a server that refuses client_connection_check_interval with 22023 still runs the job to done`, async () => {
      const db = new FakeDb();
      if (to === 'file') pgSource(db, 'src-r4-t1');
      else jsonSource();
      db.fail = sql => (/^SET client_connection_check_interval/.test(sql)
        ? dbError('22023', 'ERROR', 'invalid value for parameter "client_connection_check_interval": 10000') : undefined);
      const rec = recording(db);
      const { job, host } = await runJob(db, `job-r4-t1-${to}`, to, { connect: rec.connect });
      expect(job, why(job)).toMatchObject({ state: 'done' });
      expect(rec.seen.filter(s => /^SET client_connection_check_interval/.test(s.sql)).length).toBe(to === 'file' ? 2 : 1);
      expect(readJson(MARKER).live).toBe(to);
      expect(host.lock).toBeNull();
    });
  }

  describe("S0: this bot's last job's session", () => {
    const earlierToFile = (db: FakeDb) => {
      pgSource(db, 'src-r3-5b');
      writeJson(JOURNAL, { jobId: 'job-r3-5-last', to: 'file', stage: 'retire-source', sourceStoreId: 'src-r3-5b', startedAt: 1 });
      db.sessions.push('smdb-migrate:job-r3-5-last');
    };

    it('says the database ends it once it notices the connection is gone, whatever the server version', async () => {
      for (const [version, jobId] of [[160000, 'job-r3-5-0002'], [130000, 'job-r3-5-0003']] as const) {
        wipeRoot();
        useDatabaseUrl(PG_URL);
        loadCredentials();
        const db = new FakeDb();
        db.serverVersion = version;
        earlierToFile(db);
        const answer = await serviceFor(db, new FakeHost()).post({ jobId, to: 'file' });
        expect(answer.body.error).toBe(`can't confirm; migration job-r3-5-last's database session is still open; ${ONCE_GONE}`);
      }
    });

    it('a move to Postgres that ended after S4 gets the same text', async () => {
      jsonSource();
      writeJson(JOURNAL, { jobId: 'job-r3-5-last', to: 'postgres', stage: 'rereading', result: 'failed', error: 'x', startedAt: 1, finishedAt: 2, destination: normalizeAddress(PG_URL) });
      const db = new FakeDb();
      db.sessions.push('smdb-migrate:job-r3-5-last');
      const answer = await serviceFor(db, new FakeHost()).post({ jobId: 'job-r3-5-0004', to: 'postgres' });
      expect(answer.body.error).toBe(`can't confirm; migration job-r3-5-last's database session is still open; ${ONCE_GONE}`);
    });
  });

  describe('S2: smdb-migrate sessions', () => {
    const lastJob = () => {
      jsonSource();
      writeJson(JOURNAL, { jobId: 'job-r3-5-last', to: 'postgres', stage: 'reading', result: 'failed', error: 'x', startedAt: 1, finishedAt: 2 });
    };

    it("another job's session is not this bot's last one", async () => {
      lastJob();
      const db = new FakeDb();
      db.sessions.push('smdb-migrate:job-r3-5-other');
      const { job } = await runJob(db, 'job-r3-5-0005', 'postgres');
      expect(job, why(job)).toMatchObject({
        state: 'failed', stage: 'checking',
        error: "Migration job-r3-5-other, which is not this bot's last one, holds a session on this database; run this migration once it no longer shows",
      });
    });

    it('with no earlier journal every smdb-migrate session is another job', async () => {
      jsonSource();
      const db = new FakeDb();
      db.sessions.push('smdb-migrate:job-r3-5-other');
      const { job } = await runJob(db, 'job-r3-5-0006', 'postgres');
      expect(job.error).toBe("Migration job-r3-5-other, which is not this bot's last one, holds a session on this database; run this migration once it no longer shows");
    });

    it("this bot's last job's session gets the one text on every server version, each session named", async () => {
      lastJob();
      const db = new FakeDb();
      db.serverVersion = 130000;
      db.sessions.push('smdb-migrate:job-r3-5-last', 'smdb-migrate:job-r3-5-other');
      const { job } = await runJob(db, 'job-r3-5-0007', 'postgres');
      expect(job.error).toBe(`Migration job-r3-5-last's database session is still open; ${ONCE_GONE}. `
        + "Migration job-r3-5-other, which is not this bot's last one, holds a session on this database; run this migration once it no longer shows");
      lastJob();
      db.serverVersion = 160000;
      db.sessions.splice(db.sessions.indexOf('smdb-migrate:job-r3-5-other'), 1);
      const again = await runJob(db, 'job-r3-5-0008', 'postgres');
      expect(again.job.error).toBe(`Migration job-r3-5-last's database session is still open; ${ONCE_GONE}`);
    });
  });
});

describe('the second look: a session counts only when the same backend is there at both reads', () => {
  const OTHER = (named: string) => `1 other session(s) or worker(s) are connected to this database (${named}: 1); stop every bot and every other client of this database first`;
  const isCandidateRead = (sql: string) => /FROM pg_stat_activity WHERE datname = current_database\(\) AND usesysid IS NOT NULL/.test(sql);
  const candidateReads = (seen: Seen[]) => seen.filter(s => isCandidateRead(s.sql));
  /** A session that logs in for one read only, as pg_isready does. */
  const blip = (db: FakeDb, at: (read: number) => boolean) => {
    let shown = false;
    db.beforeSessionRead = read => {
      if (shown) {
        db.sessions.splice(db.sessions.indexOf('pg-probe'), 1);
        shown = false;
      } else if (at(read)) {
        db.sessions.push('pg-probe');
        shown = true;
      }
    };
  };

  it('a session present only at the first read does not count, and the job goes on', async () => {
    jsonSource();
    const db = new FakeDb();
    blip(db, read => read === 0);
    const { job } = await runJob(db, 'job-r6-look-0001', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(readJson(MARKER).live).toBe('postgres');
    expect(db.sessionReads).toBe(3);
  });

  it('a lasting session that joins one already there is counted at the third look, and both are named', async () => {
    jsonSource();
    const db = new FakeDb();
    db.sessions.push('other-bot');
    db.beforeSessionRead = read => {
      if (read === 1) db.sessions.push('late-bot');
    };
    const { job } = await runJob(db, 'job-r8-look-0001', 'postgres');
    expect(job, why(job)).toMatchObject({
      state: 'failed',
      stage: 'checking',
      error: "2 other session(s) or worker(s) are connected to this database (late-bot: 1, other-bot: 1); stop every bot and every other client of this database first",
    });
    expect(db.sessionReads).toBe(3);
  });

  it('a session present at both reads refuses, and only it is named', async () => {
    jsonSource();
    const db = new FakeDb();
    db.sessions.push('other-bot');
    blip(db, read => read === 0);
    const { job, host } = await runJob(db, 'job-r6-look-0002', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: OTHER('other-bot') });
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(host.lock).toBeNull();
  });

  it('a pid reused by another backend between the reads does not count', async () => {
    jsonSource();
    const db = new FakeDb();
    db.beforeSessionRead = read => {
      if (read === 0) db.sessions.push('pg-probe');
      if (read === 1) db.restart('pg-probe');
      if (read === 2) db.sessions.splice(db.sessions.indexOf('pg-probe'), 1);
    };
    const { job } = await runJob(db, 'job-r6-look-0003', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(db.sessionReads).toBe(4);
  });

  it('a lasting session that first shows at the second look is counted at the third, and refuses named', async () => {
    jsonSource();
    const db = new FakeDb();
    db.beforeSessionRead = read => {
      if (read === 0) db.sessions.push('pg-probe');
      if (read === 1) {
        db.sessions.splice(db.sessions.indexOf('pg-probe'), 1);
        db.sessions.push('late-bot');
      }
    };
    const { job, host } = await runJob(db, 'job-r7-look-0001', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: OTHER('late-bot') });
    expect(db.sessionReads).toBe(3);
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(host.lock).toBeNull();
  });

  it('a probe seen at one look only does not count when a third look is taken', async () => {
    jsonSource();
    const db = new FakeDb();
    db.beforeSessionRead = read => {
      if (read === 0) db.sessions.push('pg-probe');
      if (read === 1) {
        db.sessions.splice(db.sessions.indexOf('pg-probe'), 1);
        db.sessions.push('pg-probe-2');
      }
      if (read === 2) db.sessions.splice(db.sessions.indexOf('pg-probe-2'), 1);
    };
    const { job } = await runJob(db, 'job-r7-look-0002', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(db.sessionReads).toBe(4);
  });

  it('no third look is taken when the second finds nothing new', async () => {
    jsonSource();
    const db = new FakeDb();
    db.sessions.push('other-bot', 'pg-probe');
    db.beforeSessionRead = read => {
      if (read === 1) db.sessions.splice(db.sessions.indexOf('pg-probe'), 1);
    };
    const { job } = await runJob(db, 'job-r7-look-0003', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: OTHER('other-bot') });
    expect(db.sessionReads).toBe(2);
  });

  it('the looks stop at 3 when every look finds a new backend', async () => {
    jsonSource();
    const db = new FakeDb();
    db.sessions.push('pg-probe');
    db.beforeSessionRead = read => {
      if (read > 0) db.restart('pg-probe');
    };
    const { job } = await runJob(db, 'job-r7-look-0004', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(db.sessionReads).toBe(6);
  });

  it('a first read with no other session does not wait', async () => {
    jsonSource();
    const db = new FakeDb();
    const started = Date.now();
    const { job } = await runJob(db, 'job-r6-look-0004', 'postgres', { secondLookMs: 3000 });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(db.sessionReads).toBe(2);
  });

  it('the second look runs 1 s after the first by default', async () => {
    jsonSource();
    const db = new FakeDb();
    db.sessions.push('other-bot');
    const rec = recording(db);
    const started = Date.now();
    const { job } = await runJob(db, 'job-r6-look-0005', 'postgres', { connect: rec.connect, secondLookMs: undefined });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: OTHER('other-bot') });
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    expect(candidateReads(rec.seen)).toHaveLength(2);
  });

  it('inside the transaction of S4 the snapshot is cleared before the second read', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-r6-look');
    const rec = recording(db);
    blip(db, () => readJson(JOURNAL).stage === 'reading');
    const { job } = await runJob(db, 'job-r6-look-0006', 'file', { connect: rec.connect });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const main = rec.seen.filter(s => s.n === 0).map(s => s.sql);
    const begin = main.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const reads = main.map((sql, i) => (isCandidateRead(sql) && i > begin ? i : -1)).filter(i => i >= 0);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(main.slice(reads[0] + 1, reads[1])).toEqual(['SELECT pg_stat_clear_snapshot()']);
  });
});

describe("statementBytes counts what pg's own serializer writes", () => {
  const { prepareValue } = require('pg/lib/utils') as { prepareValue: (v: unknown) => string | Buffer | null };
  const written = (text: string, params: unknown[]) => params.reduce<number>((sum, p) => {
    const v = prepareValue(p);
    return sum + (v === null ? 0 : Buffer.isBuffer(v) ? v.length : Buffer.byteLength(v));
  }, Buffer.byteLength(text));
  const wide = String.fromCharCode(0xe9, 0x65e5, 0x672c);
  const text = 'INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) SELECT * FROM unnest($1::text[], $2::text[])';
  const shapes: Array<[string, unknown[]]> = [
    ['the job columns', [['890000000000000001', '890000000000000002'], ['mod'], ['a.json'], [`{"k":"v \\"q\\" \\\\ ${wide}"}`]]],
    ['number columns', [[0, 3, 12], ['0', '1700000000000'], [16, 16]]],
    ['empty arrays', [[], [[]], ['']]],
    ['plain strings and numbers', ['890000000000000001', 'smdb-migrate:job-x', 42, '']],
    ['the session filter', [[['smdb-migrate:job-r7-0001', 'smdb-webui']]]],
    ['nulls', [null, undefined, [null, 'a', undefined, null]]],
    ['buffers', [Buffer.from(`plain ${wide} bytes`), [Buffer.from([0, 1, 255]), Buffer.alloc(0), 'x']]],
    ['nesting', [[['a', ['b', null, 'c"d']], [], [['\\'], [Buffer.from('z')]]]]],
    ['quotes and backslashes', [['"', '\\', '\\"', '""\\\\', 'a"b\\c', '{,}']]],
    ['objects and booleans', [[{ a: 'x"y' }, true, false], { b: ['\\'] }]],
  ];
  for (const [name, params] of shapes) {
    it(name, () => {
      expect(statementBytes(text, params)).toBe(written(text, params));
    });
  }
});
