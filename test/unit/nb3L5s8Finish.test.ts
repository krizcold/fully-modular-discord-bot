import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 S7 to S12: the second read of the source, the new store's id, the shadow rows, the placement, the fault points
// after the retire and the switch, and the job's last log lines.

const G1 = '880000000000000301';
const G2 = '880000000000000302';

let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  loadCredentials();
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function runJob(db: FakeDb, jobId: string, to: 'file' | 'postgres', extra: { fault?: (p: string) => void | Promise<void>; connect?: any } = {}) {
  const service = serviceFor(db, new FakeHost(), extra);
  const answer = await service.post({ jobId, to });
  expect(answer.body.state, why(answer)).toBe('started');
  await service.idle();
  return service;
}

function pgSource(db: FakeDb, storeId: string, grave: any[] = []): void {
  writeJson(MARKER, { live: 'postgres', storeId, flippedAt: 1 });
  db.schemas.set('smdb_data', {
    ...emptyStore(storeId),
    data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }, { guild_id: G2, module: 'm', filename: 'b.json', doc: '{"b":2}' }],
    grave,
  });
}

function jsonSource(): void {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"a":1}');
  seedFile(`${G2}/m/b.json`, '{"b":2}');
}

const graveRow = (retired: string) => ({ guild_id: G1, module: 'm', filename: 'g.json', kind: 'doc', doc: '{"g":1}', retired_at: retired, reason: 'left' });

describe('S7: the source read a second time', () => {
  it('a JSON source changed since the first read fails the job, naming the second read', async () => {
    const db = new FakeDb();
    jsonSource();
    const service = await runJob(db, 'job-s8-rr-001', 'postgres', {
      fault: p => { if (p === 'S7') fs.writeFileSync(path.join(root, G1, 'm', 'a.json'), '{"a":2}'); },
    });
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(job.error).toMatch(/^The source read a second time differs from the source in 1 document\(s\): /);
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER).live).toBe('file');
  });

  it('a Postgres source changed since the first read fails the job, naming the second read', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-rr');
    const service = await runJob(db, 'job-s8-rr-002', 'file', {
      fault: p => { if (p === 'S7') db.schemas.get('smdb_data')!.data[0].doc = '{"a":2}'; },
    });
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(job.error).toMatch(/^The source read a second time differs from the source in 1 document\(s\): /);
    expect(fs.existsSync(path.join(root, G1))).toBe(false);
    expect(readJson(MARKER).live).toBe('postgres');
    expect(db.schemas.get('smdb_data')!.storeId).toBe('src-s8-rr');
  });
});

describe('S8: the new store\'s id', () => {
  it('a new store whose id reads back as none fails the job with that text', async () => {
    const db = new FakeDb();
    jsonSource();
    let after = false;
    const connect = async (_url: string, app: string): Promise<PgSession> => {
      const client = db.connect(app);
      return {
        query: (text: string, params: any[] = []) => (after && /^SELECT value FROM "smdb_data"\.meta WHERE key = 'store_id'/.test(text)
          ? Promise.resolve({ rows: [] }) : client.query(text, params)),
        end: () => client.end(),
      } as unknown as PgSession;
    };
    const service = await runJob(db, 'job-s8-id-0001', 'postgres', { connect, fault: p => { if (p === 'S7') after = true; } });
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed' });
    expect(job.error).toBe('The new store has no store id');
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});

describe('S8 to JSON: the shadow rows', () => {
  it('a shadow file already in the superseded folder is kept, and the job refuses naming it', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-sh');
    db.schemas.get('smdb_data')!.data.push({ guild_id: G2, module: 'm/', filename: '../m/b.json', doc: '{"shadow":1}' });
    fs.mkdirSync(path.join(root, '.migrate-1'));
    let target = '';
    const service = await runJob(db, 'job-s8-sh-0001', 'file', {
      fault: p => {
        if (p !== 'S8') return;
        const names = fs.readdirSync(path.join(root, '_superseded'));
        expect(names).toHaveLength(1);
        target = path.join(root, '_superseded', names[0], 'shadow', G2, `${encodeURIComponent('m/')}__${encodeURIComponent('../m/b.json')}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'earlier');
      },
    });
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'placing' });
    expect(job.error).toBe(`${target} exists; nothing was moved`);
    expect(fs.readFileSync(target, 'utf-8')).toBe('earlier');
    expect(readJson(MARKER).live).toBe('postgres');
  });
});

describe('S8 to JSON: a placement that fails after its first move', () => {
  it('keeps the staging folder with the copy', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-pl');
    seedFile(`${G1}/m/old.json`, '{"old":1}');
    const real = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (String(from).includes(`${path.sep}.migrate-`) && String(to) === path.join(root, G2)) {
        throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
      }
      return real(from, to);
    }) as typeof fs.promises.rename);
    const service = await runJob(db, 'job-s8-pl-0001', 'file');
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'placing' });
    const staging = fs.readdirSync(root).filter(n => n.startsWith('.migrate-'));
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, staging[0], G2, 'm', 'b.json'), 'utf-8')).toBe('{"b":2}');
    expect(readJson(MARKER).live).toBe('postgres');
  });
});

describe('the fault points after the retire and at S12', () => {
  it('a stop right after the retire COMMIT leaves the job interrupted', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-fp');
    const service = await runJob(db, 'job-s8-fp-0001', 'file', { fault: p => { if (p === 'after-retire-commit') throw new Error('stop after retire'); } });
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'retire-source' });
    expect(readJson(JOURNAL)).toMatchObject({ result: 'interrupted', stage: 'retire-source', error: 'stop after retire' });
  });

  it('a stop at S12 leaves the job interrupted after the switch', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-fq');
    const service = await runJob(db, 'job-s8-fp-0002', 'file', { fault: p => { if (p === 'S12') throw new Error('stop at S12'); } });
    const job = service.status().body.job;
    expect(readJson(JOURNAL), why(job)).toMatchObject({ result: 'interrupted', error: 'stop at S12' });
    expect(readJson(MARKER).live).toBe('file');
  });
});

describe('S12: the journal\'s done and the last log line', () => {
  it('a done that cannot be written to the journal is logged as such', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-jd');
    await runJob(db, 'job-s8-jd-0001', 'file', {
      fault: p => {
        if (p !== 'S12') return;
        fs.rmSync(JOURNAL, { force: true });
        fs.mkdirSync(JOURNAL);
      },
    });
    const line = errors.find(e => e.startsWith('[Migration] Migration job-s8-jd-0001 is done, but its journal\'s done could not be written: '));
    expect(line, why(errors)).toBeDefined();
    expect(readJson(MARKER).live).toBe('file');
  });

  it('logs the counts, with no left-out part when nothing was left out', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-lg', [graveRow('1700000000000')]);
    await runJob(db, 'job-s8-lg-0001', 'file');
    expect(logs).toContain('[Migration] Migration job-s8-lg-0001 (--to file) is done: 2 documents, 0 streams, 1 graveyard entries');
  });

  it('names every item left out, comma separated', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-s8-lo', [graveRow('1700000000000'), graveRow('9007199254740993'), graveRow('9007199254740995')]);
    await runJob(db, 'job-s8-lg-0002', 'file');
    const left = (r: string) => `graveyard entry ${G1}-${r} in the database (its retired_at cannot name a folder exactly)`;
    expect(logs).toContain('[Migration] Migration job-s8-lg-0002 (--to file) is done: 2 documents, 0 streams, 1 graveyard entries'
      + `; left out: ${left('9007199254740993')}, ${left('9007199254740995')}`);
  });
});
