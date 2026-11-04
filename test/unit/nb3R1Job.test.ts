import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 code review round 1, the job's side: DL-1, DL-2, FR-1, WB-1, RS-1, RS-5, RS-8, the session refusal's names,
// the T9 fault points and the copy held to one guild at a time.

const pgConfigs = vi.hoisted(() => [] as any[]);
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/pgClient')>();
  return {
    ...real,
    shortLivedClient: (config: any) => {
      pgConfigs.push(config);
      return { connect: async () => undefined, end: async () => undefined, query: async () => ({ rows: [] }), on: () => undefined };
    },
  };
});

import { openJobSession, snapshotFromPgRows, walkJsonSource, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, STORES, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

const G1 = '770000000000000001';
const G2 = '770000000000000002';
const die = () => Object.assign(new Error('the process died'), { simulateDeath: true });

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

/** A Postgres source of two guilds with the marker naming it. */
function pgSource(db: FakeDb, storeId = 'src-r1'): void {
  writeJson(MARKER, { live: 'postgres', storeId, flippedAt: 1 });
  db.schemas.set('smdb_data', {
    ...emptyStore(storeId),
    data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }, { guild_id: G2, module: 'm', filename: 'b.json', doc: '{"b":2}' }],
  });
}

/** The fake's client with every statement and its parameters recorded, and a socket whose destroy is seen. */
function recording(db: FakeDb, seen: Array<{ app: string; sql: string; params: any[] }>, override?: (sql: string) => Promise<any> | undefined) {
  const destroyed: string[] = [];
  const connect = async (_url: string, app: string): Promise<PgSession> => {
    const client = db.connect(app);
    const session = {
      query: (text: string, params: any[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        seen.push({ app, sql, params });
        return override?.(sql) ?? client.query(text, params);
      },
      end: () => override?.('END') ?? client.end(),
      connection: { stream: { destroy: () => { destroyed.push(app); void client.end(); } } },
    };
    return session as unknown as PgSession;
  };
  return { connect, destroyed };
}

describe('NB3-DL-1: every session count clears the statistics snapshot first', () => {
  it('each count of other sessions follows its own pg_stat_clear_snapshot() on the same session', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    const db = new FakeDb();
    const seen: Array<{ app: string; sql: string; params: any[] }> = [];
    const service = serviceFor(db, new FakeHost(), { connect: recording(db, seen).connect });
    await service.post({ jobId: 'job-r1-dl1-01', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job.state).toBe('done');
    const counts = seen.map((s, i) => [s, i] as const).filter(([s]) => /pg_stat_activity/.test(s.sql) && /<> ALL/.test(s.sql));
    expect(counts.length).toBeGreaterThanOrEqual(2);
    for (const [s, i] of counts) expect(seen[i - 1]).toMatchObject({ app: s.app, sql: 'SELECT pg_stat_clear_snapshot()' });
  });

  it('a session that connects after the read transaction\'s first count is refused at S8 (to JSON)', async () => {
    const db = new FakeDb();
    pgSource(db);
    const service = serviceFor(db, new FakeHost(), { fault: p => { if (p === 'S5') db.sessions.push('late-bot'); } });
    await service.post({ jobId: 'job-r1-dl1-02', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'placing' });
    expect(job.error).toMatch(/1 other session\(s\).*late-bot: 1/);
    expect(db.schemas.get('smdb_data')?.storeId).toBe('src-r1');
    expect(readJson(MARKER).live).toBe('postgres');
  });

  it('a session that connects after the copy transaction\'s first count is refused before committing (to Postgres over a listed store)', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    const db = new FakeDb();
    db.schemas.set('smdb_data', { ...emptyStore('listed-r1'), data: [{ guild_id: G2, module: 'm', filename: 'old.json', doc: '{}' }] });
    writeJson(STORES, { storeIds: ['listed-r1'] });
    writeJson(JOURNAL, { jobId: 'job-r1-listed', to: 'postgres', stage: 'committing', startedAt: 1, storeId: 'listed-r1' });
    const service = serviceFor(db, new FakeHost(), { fault: p => { if (p === 'S6') db.sessions.push('late-bot'); } });
    await service.post({ jobId: 'job-r1-dl1-03', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(job.error).toMatch(/1 other session\(s\).*late-bot: 1/);
    expect(db.schemas.get('smdb_data')?.storeId).toBe('listed-r1');
    expect([...db.schemas.keys()].filter(n => n.startsWith('smdb_superseded_'))).toEqual([]);
    expect(readJson(MARKER).live).toBe('file');
  });
});

describe('the session refusal names the sessions', () => {
  it('names each application_name with its count, an empty one as unnamed', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    const db = new FakeDb();
    db.sessions.push('other-bot', 'other-bot', '');
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-r1-names-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe("3 other session(s) of the bot's database role are connected (unnamed: 1, other-bot: 2); stop every bot on this database first");
  });
});

describe('NB3-DL-2: the walk refuses what the file backend would serve but the copy cannot read', () => {
  const asLink = (target: string) => {
    const real = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      const st = await (real as any)(p, ...rest);
      if (path.resolve(String(p)) === path.resolve(target)) return { ...st, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
      return st;
    }) as any);
  };

  it('a numeric folder at the root that is a link refuses, naming the path', async () => {
    seedFile(`${G1}/m/a.json`, '{}');
    seedFile(`${G2}/m/b.json`, '{}');
    asLink(path.join(root, G2));
    await expect(walkJsonSource(root)).rejects.toThrow(path.join(root, G2));
    await expect(walkJsonSource(root)).rejects.toThrow(/not a folder/);
  });

  it('a numeric entry whose lstat fails refuses, naming the path', async () => {
    seedFile(`${G1}/m/a.json`, '{}');
    const target = path.join(root, G1);
    const real = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(target)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (real as any)(p, ...rest);
    }) as any);
    await expect(walkJsonSource(root)).rejects.toThrow(`${target} cannot be read`);
  });

  it('a _graveyard that is a file or a link, and a child of _graveyard that is not a folder, refuse', async () => {
    seedFile('_graveyard', 'x');
    await expect(walkJsonSource(root)).rejects.toThrow(path.join(root, '_graveyard'));
    wipeRoot();
    seedFile(`_graveyard/${G1}-1700000000000/m/a.json`, '{}');
    asLink(path.join(root, '_graveyard'));
    await expect(walkJsonSource(root)).rejects.toThrow(/not a folder/);
    vi.restoreAllMocks();
    wipeRoot();
    seedFile(`_graveyard/${G1}-1700000000000/m/a.json`, '{}');
    seedFile('_graveyard/stray.json', '{}');
    await expect(walkJsonSource(root)).rejects.toThrow(path.join(root, '_graveyard', 'stray.json'));
    wipeRoot();
    seedFile(`_graveyard/${G1}-1700000000000/m/a.json`, '{}');
    asLink(path.join(root, '_graveyard', `${G1}-1700000000000`));
    await expect(walkJsonSource(root)).rejects.toThrow(`${G1}-1700000000000`);
  });

  it('a regular file with a numeric name at the root stays skipped', async () => {
    seedFile(`${G1}/m/a.json`, '{}');
    seedFile('123456', 'not data');
    const snap = await walkJsonSource(root);
    expect(snap.guilds).toEqual([G1]);
    expect(snap.leftOut).toEqual([]);
  });

  it('the job fails at reading, naming the linked folder, and switches nothing', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    asLink(path.join(root, G1));
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-r1-dl2-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job.error).toContain(path.join(root, G1));
    expect(readJson(MARKER).live).toBe('file');
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});

describe('NB3-FR-1: a second POST while S0 classifies', () => {
  function earlierJob(db: FakeDb): void {
    pgSource(db, 'src-fr1');
    writeJson(JOURNAL, { jobId: 'job-r1-earlier', to: 'file', stage: 'retire-source', sourceStoreId: 'src-fr1', startedAt: 1 });
  }

  function slowProbe(db: FakeDb) {
    return async (_url: string, app: string, kind: 'job' | 'probe') => {
      if (kind === 'probe') await new Promise(resolve => { setTimeout(resolve, 150); });
      return db.connect(app) as unknown as PgSession;
    };
  }

  it('waits for the first request\'s answer and answers the same; the job runs once', async () => {
    const db = new FakeDb();
    earlierJob(db);
    const host = new FakeHost();
    const service = serviceFor(db, host, { connect: slowProbe(db) });
    const [a, b] = await Promise.all([
      service.post({ jobId: 'job-r1-fr1-a1', to: 'file' }),
      service.post({ jobId: 'job-r1-fr1-b1', to: 'file' }),
    ]);
    expect(a.body).toMatchObject({ success: true, jobId: 'job-r1-fr1-a1', state: 'started' });
    expect(b).toEqual(a);
    expect(host.calls.filter(c => c === 'take')).toHaveLength(1);
    await service.idle();
    expect(service.status().body.job).toMatchObject({ jobId: 'job-r1-fr1-a1', state: 'done' });
  });

  it('a first request that is refused gives the second the same refusal, and no job runs', async () => {
    const db = new FakeDb();
    earlierJob(db);
    db.sessions.push('smdb-migrate:job-r1-earlier');
    const host = new FakeHost();
    const service = serviceFor(db, host, { connect: slowProbe(db) });
    const [a, b] = await Promise.all([
      service.post({ jobId: 'job-r1-fr1-a2', to: 'file' }),
      service.post({ jobId: 'job-r1-fr1-b2', to: 'file' }),
    ]);
    expect(a.body).toMatchObject({ success: false, error: "can't confirm; migration job-r1-earlier's database session is still open; the database ends it once it notices the connection is gone; run the migration again once it no longer shows" });
    expect(b).toEqual(a);
    expect(host.lock).toBeNull();
    expect(service.running()).toBeNull();
    expect(readJson(JOURNAL).jobId).toBe('job-r1-earlier');
  });

  it('a second POST of the other direction waits, then answers against the job that started', async () => {
    const db = new FakeDb();
    earlierJob(db);
    const service = serviceFor(db, new FakeHost(), { connect: slowProbe(db) });
    const [a, b] = await Promise.all([
      service.post({ jobId: 'job-r1-fr1-a3', to: 'file' }),
      service.post({ jobId: 'job-r1-fr1-b3', to: 'postgres' }),
    ]);
    expect(a.body.state).toBe('started');
    expect(b).toMatchObject({ status: 409, body: { success: false, error: 'Migration job-r1-fr1-a3 (--to file) is running' } });
    await service.idle();
  });

  it('a second POST of the other direction, beside a first that is refused, is judged on its own facts', async () => {
    const db = new FakeDb();
    earlierJob(db);
    db.sessions.push('smdb-migrate:job-r1-earlier');
    const host = new FakeHost();
    const service = serviceFor(db, host, { connect: slowProbe(db) });
    const [a, b] = await Promise.all([
      service.post({ jobId: 'job-r1-fr1-a4', to: 'file' }),
      service.post({ jobId: 'job-r1-fr1-b4', to: 'postgres' }),
    ]);
    expect(a.body).toMatchObject({ success: false, error: "can't confirm; migration job-r1-earlier's database session is still open; the database ends it once it notices the connection is gone; run the migration again once it no longer shows" });
    expect(b.body.error).not.toMatch(/job-r1-fr1-a4 .* is running/);
    expect(b).toMatchObject({ status: 409, body: { success: false, error: 'The data is already on postgres; migration job-r1-earlier (--to file) is unfinished at retire-source; run it again with --to file' } });
    expect(host.lock).toBeNull();
    expect(service.running()).toBeNull();
    expect(readJson(JOURNAL).jobId).toBe('job-r1-earlier');
  });
});

describe('NB3-WB-1: the file-and-folder check tests every prefix', () => {
  const doc = (filename: string, module = 'mod') => ({ guild_id: G1, module, filename, doc: '{}' });

  it('refuses a file and a folder of one name when another key sorts between them', () => {
    expect(() => snapshotFromPgRows([doc('cfg'), doc('cfg.json'), doc('cfg/x.json')], [], [])).toThrow(/mod\/cfg of guild 770000000000000001 is both a file and a folder/);
  });

  it('refuses a file and a folder that differ only in letter case', () => {
    expect(() => snapshotFromPgRows([doc('cfg'), doc('CFG/x.json')], [], [])).toThrow(/differ only in letter case/);
    expect(() => snapshotFromPgRows([doc('a.json', 'Mod'), doc('a.json', 'mod')], [], [])).toThrow(/differ only in letter case/);
  });

  it('accepts names that share a start but no folder', () => {
    expect(snapshotFromPgRows([doc('cfg.json'), doc('cfg/x.json'), doc('cfgx/y.json')], [], []).items).toHaveLength(3);
  });
});

describe('NB3-RS-1: bounded waits on a silent database', () => {
  it('job sessions set a client keepalive of 30 s', async () => {
    pgConfigs.length = 0;
    await openJobSession(PG_URL, 'smdb-migrate:job-r1-rs1-00', 'job', 1000);
    expect(pgConfigs[0]).toMatchObject({ keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
  });

  it('a COMMIT with no answer ends interrupted at committing within the bound, destroys the socket and releases the lock', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    const db = new FakeDb();
    const host = new FakeHost();
    const rec = recording(db, [], sql => (sql === 'COMMIT' ? new Promise(() => undefined) : undefined));
    const service = serviceFor(db, host, { connect: rec.connect, commitBoundMs: 50, closeBoundMs: 50 });
    await service.post({ jobId: 'job-r1-rs1-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL).error).toMatch(/^The COMMIT got no answer/);
    expect(rec.destroyed).toContain('smdb-migrate:job-r1-rs1-01');
    expect(host.lock).toBeNull();
    expect(readJson(MARKER).live).toBe('file');
  });

  it('a ROLLBACK with no answer, and an end with no answer, destroy the socket after the bound', async () => {
    for (const [point, jobId, stage] of [['S6', 'job-r1-rs1-02', 'verifying'], ['S3', 'job-r1-rs1-03', 'draining']] as const) {
      freshJsonBot();
      seedFile(`${G1}/m/a.json`, '{}');
      const db = new FakeDb();
      const host = new FakeHost();
      const rec = recording(db, [], sql => (sql === 'ROLLBACK' || sql === 'END' ? new Promise(() => undefined) : undefined));
      const service = serviceFor(db, host, {
        connect: rec.connect, closeBoundMs: 50, fault: p => { if (p === point) throw new Error('injected failure'); },
      });
      await service.post({ jobId, to: 'postgres' });
      await service.idle();
      expect(service.status().body.job, point).toMatchObject({ state: 'failed', stage });
      expect(rec.destroyed, point).toEqual([`smdb-migrate:${jobId}`]);
      expect(host.lock, point).toBeNull();
    }
  });
});

describe('NB3-RS-5: the pinned DATA_BACKEND refusal names the step that works', () => {
  it('tells the operator to remove it from the container environment, keep it in /data/.env, restart and run again', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    seedFile('.env', 'A=1\n');
    loadCredentials();
    process.env.DATA_BACKEND = 'file';
    const service = serviceFor(new FakeDb(), new FakeHost());
    await service.post({ jobId: 'job-r1-rs5-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe('DATA_BACKEND is set by the container environment, so the migration cannot switch it; remove DATA_BACKEND from the container environment (keep it in /data/.env), restart the container, and run the migration again');
  });
});

describe('NB3-RS-8: an address that cannot be parsed or reached names its source', () => {
  it('an unparseable url in the request is named as the request\'s', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'token';
    const service = serviceFor(new FakeDb(), new FakeHost());
    await service.post({ jobId: 'job-r1-rs8-01', to: 'postgres', url: 'postgres//bad' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe('The destination address given in the request cannot be parsed as a database address');
  });

  it('an unparseable DATA_BACKEND_URL is named as DATA_BACKEND_URL', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    useDatabaseUrl('postgres//bad');
    const service = serviceFor(new FakeDb(), new FakeHost());
    await service.post({ jobId: 'job-r1-rs8-02', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job.error).toBe('DATA_BACKEND_URL cannot be parsed as a database address');
  });

  it('an address that cannot be reached names host, port, database and source, never the password', async () => {
    for (const [managed, jobId, source, url] of [
      [false, 'job-r1-rs8-03', 'DATA_BACKEND_URL', undefined],
      [true, 'job-r1-rs8-04', 'the address given in the request', 'postgres://bot:secretpw@other.example:6543/dest'],
    ] as const) {
      freshJsonBot();
      seedFile(`${G1}/m/a.json`, '{}');
      if (managed) process.env.BOT_MANAGER_UPDATE_TOKEN = 'token';
      else delete process.env.BOT_MANAGER_UPDATE_TOKEN;
      const db = new FakeDb();
      db.unreachable = true;
      const service = serviceFor(db, new FakeHost());
      await service.post({ jobId, to: 'postgres', ...(url ? { url } : {}) });
      await service.idle();
      const error: string = service.status().body.job.error;
      const where = managed ? 'other.example:6543/dest' : 'db.example:5432/smdb';
      expect(error).toBe(`can't reach the database at ${where} (from ${source}): connect ECONNREFUSED`);
      expect(error).not.toMatch(/pw|secret/);
    }
  });
});

describe('T9: fault points immediately before each COMMIT', () => {
  it('a death at commit-send leaves the journal at committing with no COMMIT sent, read as interrupted', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost(), { fault: p => { if (p === 'commit-send') throw die(); } });
    await service.post({ jobId: 'job-r1-t9-001', to: 'postgres' });
    await service.idle();
    expect(readJson(JOURNAL)).toMatchObject({ stage: 'committing' });
    expect(readJson(JOURNAL).result).toBeUndefined();
    expect(db.statements().filter(s => s === 'COMMIT')).toEqual([]);
    expect(service.status().body.job).toMatchObject({ state: 'interrupted', stage: 'committing' });
  });

  it('a death at retire-commit-send leaves the journal at retire-source with no COMMIT sent, read as interrupted', async () => {
    const db = new FakeDb();
    pgSource(db);
    const service = serviceFor(db, new FakeHost(), { fault: p => { if (p === 'retire-commit-send') throw die(); } });
    await service.post({ jobId: 'job-r1-t9-002', to: 'file' });
    await service.idle();
    expect(readJson(JOURNAL)).toMatchObject({ stage: 'retire-source' });
    expect(db.statements().filter(s => s === 'COMMIT')).toEqual([]);
    expect(db.schemas.get('smdb_data')?.storeId).toBe('src-r1');
    expect(service.status().body.job).toMatchObject({ state: 'interrupted', stage: 'retire-source' });
  });
});

describe('the copy holds one guild at a time', () => {
  it('a JSON source goes into the database transaction guild by guild', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    seedFile(`${G1}/m/l.jsonl`, 'x\n');
    seedFile(`${G2}/m/b.json`, '{"b":2}');
    const db = new FakeDb();
    const seen: Array<{ app: string; sql: string; params: any[] }> = [];
    const service = serviceFor(db, new FakeHost(), { connect: recording(db, seen).connect });
    await service.post({ jobId: 'job-r1-mem-01', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job.state).toBe('done');
    const inserts = seen.filter(s => /^INSERT INTO smdb_data\.guild_(data|append) /.test(s.sql));
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    for (const s of inserts) expect(new Set(s.params[0]).size).toBeLessThanOrEqual(1);
    expect(db.schemas.get('smdb_data')?.data.map(r => r.guild_id).sort()).toEqual([G1, G2]);
  });

  it('a Postgres source is read guild by guild in each of its reads, and shadow rows are still written', async () => {
    const db = new FakeDb();
    pgSource(db);
    db.schemas.get('smdb_data')!.data.push({ guild_id: G2, module: 'm/', filename: '../m/b.json', doc: '{"shadow":1}' });
    db.schemas.get('smdb_data')!.grave.push({ guild_id: G1, module: 'm', filename: 'old.json', kind: 'doc', doc: '{"o":1}', retired_at: '1700000000000', reason: 'left' });
    const seen: Array<{ app: string; sql: string; params: any[] }> = [];
    const service = serviceFor(db, new FakeHost(), { connect: recording(db, seen).connect });
    await service.post({ jobId: 'job-r1-mem-02', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const reads = seen.filter(s => /^SELECT .*\b(doc|chunk)\b.* FROM smdb_data\.guild_(data|append|data_graveyard)\b/.test(s.sql) && !/sha256/.test(s.sql));
    expect(reads.length).toBeGreaterThan(0);
    for (const s of reads) expect(s.sql).toMatch(/WHERE guild_id = \$1/);
    expect(fs.readFileSync(path.join(root, G1, 'm', 'a.json'), 'utf-8')).toBe('{"a":1}');
    expect(fs.readFileSync(path.join(root, '_graveyard', `${G1}-1700000000000`, 'm', 'old.json'), 'utf-8')).toBe('{"o":1}');
    expect(job.shadow).toHaveLength(1);
    const shadowDir = path.join(root, '_superseded');
    const found: string[] = [];
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else found.push(p); } };
    walk(shadowDir);
    expect(found.some(p => p.includes(`${path.sep}shadow${path.sep}${G2}${path.sep}`) && fs.readFileSync(p, 'utf-8') === '{"shadow":1}')).toBe(true);
  });
});
