import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAddress, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { ENV, FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, root, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 mutation gate, round u1: a done journal finished again without a finishedAt, the database a move to JSON reads,
// and the S4 recheck when the source store's id is gone.

const G1 = '880000000000000401';
const G2 = '880000000000000402';
const OLD = 'job-u1-old-01';

beforeEach(() => {
  wipeRoot();
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
});

function pgSource(db: FakeDb, storeId: string): void {
  writeJson(MARKER, { live: 'postgres', storeId, flippedAt: 1 });
  db.schemas.set('smdb_data', {
    ...emptyStore(storeId),
    data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }, { guild_id: G2, module: 'm', filename: 'b.json', doc: '{"b":2}' }],
  });
}

describe('a done journal with no finishedAt, finished again', () => {
  it('records the time it was finished, in the journal and in the status', async () => {
    freshJsonBot();
    writeJson(MARKER, { live: 'postgres', storeId: 'copy-u1', flippedAt: 1, migration: OLD });
    writeJson(JOURNAL, {
      jobId: OLD, to: 'postgres', stage: 'env', result: 'done', startedAt: 1, storeId: 'copy-u1',
      destination: normalizeAddress(PG_URL), envSwitched: false,
    });
    fs.writeFileSync(ENV, 'DATA_BACKEND=file\n');
    const before = Date.now();
    const service = serviceFor(new FakeDb(), new FakeHost());
    const answer = await service.post({ jobId: 'job-u1-new-01', to: 'postgres' });
    const after = Date.now();
    expect(answer.body, why(answer)).toMatchObject({ success: true, jobId: OLD, state: 'done' });
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=postgres\n');
    const j = readJson(JOURNAL);
    expect(j, why(j)).toMatchObject({ result: 'done', envSwitched: true });
    expect(typeof j.finishedAt).toBe('number');
    expect(j.finishedAt).toBeGreaterThanOrEqual(before);
    expect(j.finishedAt).toBeLessThanOrEqual(after);
    expect(service.status().body.job.finishedAt).toBe(j.finishedAt);
  });
});

describe('a move to JSON given an address in the request', () => {
  it('reads the source from DATA_BACKEND_URL and never connects to the request\'s address', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-u1-a');
    const urls: string[] = [];
    const service = serviceFor(db, new FakeHost(), {
      connect: async (url: string, app: string): Promise<PgSession> => {
        urls.push(url);
        return db.connect(app) as unknown as PgSession;
      },
    });
    const answer = await service.post({ jobId: 'job-u1-url-01', to: 'file', url: 'postgres://u:pw@other.example:5432/elsewhere' });
    expect(answer.body.state, why(answer)).toBe('started');
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(u => u === PG_URL), why(urls)).toBe(true);
    expect(readJson(JOURNAL).source).toEqual(normalizeAddress(PG_URL));
    expect(fs.readFileSync(path.join(root, G1, 'm', 'a.json'), 'utf-8')).toBe('{"a":1}');
  });
});

describe('S4: a Postgres source whose store id is gone at the recheck', () => {
  it('refuses, saying the store changed to none', async () => {
    const db = new FakeDb();
    pgSource(db, 'src-u1-b');
    const service = serviceFor(db, new FakeHost(), { fault: (p: string) => { if (p === 'S4') db.schemas.get('smdb_data')!.storeId = null; } });
    const answer = await service.post({ jobId: 'job-u1-s4-01', to: 'file' });
    expect(answer.body.state, why(answer)).toBe('started');
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job.error).toBe("The database's store changed to none since the first check (src-u1-b)");
    expect(readJson(MARKER).live).toBe('postgres');
    expect(fs.existsSync(path.join(root, G1))).toBe(false);
  });
});
