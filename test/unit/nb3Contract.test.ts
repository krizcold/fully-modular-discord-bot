import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, seedFile, serviceFor, snapshotRoot, useDatabaseUrl, wipeRoot, writeJson } from '../helpers/migrationRig';

// NB3 decision 15 and contract 9: the POST and GET answers.

const G = '131313131313131313';

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the POST', () => {
  it('answers within 5 s with started; a request of the running to answers the running job; the other to is refused naming it', async () => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{}');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = serviceFor(new FakeDb(), new FakeHost(), { fault: async point => { if (point === 'S4') await gate; } });
    const t0 = Date.now();
    const first = await service.post({ jobId: 'job-contract-1', to: 'postgres' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(first).toMatchObject({ status: 200, body: { success: true, jobId: 'job-contract-1', to: 'postgres', state: 'started' } });
    expect((await service.post({ jobId: 'job-contract-2', to: 'postgres' })).body).toMatchObject({ success: true, jobId: 'job-contract-1', to: 'postgres', state: 'running' });
    const other = await service.post({ jobId: 'job-contract-3', to: 'file' });
    expect(other.body).toMatchObject({ success: false, jobId: 'job-contract-1', to: 'postgres' });
    expect(other.body.error).toBe('Migration job-contract-1 (--to postgres) is running');
    release();
    await service.idle();
  });

  it('a known jobId of another to answers that job, with its stage and error', async () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-contract-4', to: 'file', stage: 'reading', result: 'failed', error: 'boom', startedAt: 1 });
    const service = serviceFor(new FakeDb(), new FakeHost());
    expect((await service.post({ jobId: 'job-contract-4', to: 'postgres' })).body).toMatchObject({
      success: true, jobId: 'job-contract-4', to: 'file', state: 'failed', stage: 'reading', error: 'boom',
    });
  });

  it('a jobId outside 8 to 40 letters, digits and "-" answers 400', async () => {
    const service = serviceFor(new FakeDb(), new FakeHost());
    for (const jobId of ['abc', 'a'.repeat(41), 'job id 0001', 'job_id_0001', 7]) {
      expect((await service.post({ jobId, to: 'postgres' })).status).toBe(400);
    }
    expect((await service.post({ jobId: 'job-contract-5', to: 'mysql' })).status).toBe(400);
  });

  it('answers "can\'t confirm" when the classification\'s read passes its 2 s bound', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: 'src-c' });
    writeJson(JOURNAL, { jobId: 'job-contract-6', to: 'file', stage: 'retire-source', sourceStoreId: 'src-c', startedAt: 1 });
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('src-c'));
    const service = serviceFor(db, new FakeHost(), { connect: async (_u, app) => { await new Promise(r => setTimeout(r, 2600)); return db.connect(app); } });
    const t0 = Date.now();
    const answer = await service.post({ jobId: 'job-contract-7', to: 'file' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(answer.body.success).toBe(false);
    expect(answer.body.error).toMatch(/^can't confirm/);
  });

  it('answers "can\'t confirm" when the classification\'s transaction passes its 2 s bound after connecting, and changes nothing', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: 'src-t' });
    writeJson(JOURNAL, { jobId: 'job-contract-c', to: 'file', stage: 'retire-source', sourceStoreId: 'src-t', startedAt: 1 });
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('src-t'));
    let delayed = 0;
    const service = serviceFor(db, new FakeHost(), {
      connect: async (_u, app) => {
        const client = db.connect(app);
        return {
          query: async (text: string, params?: unknown[]) => {
            if (/nspname LIKE/.test(text)) {
              delayed += 1;
              await new Promise(r => setTimeout(r, 2600));
            }
            return client.query(text, params as any[]);
          },
          end: () => client.end(),
        };
      },
    });
    const before = snapshotRoot();
    const t0 = Date.now();
    const answer = await service.post({ jobId: 'job-contract-d', to: 'file' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(delayed).toBe(1);
    expect(answer.body.success).toBe(false);
    expect(answer.body.error).toMatch(/^can't confirm/);
    expect(answer.body.error).toMatch(/the read of the database took longer than 2 s/);
    expect(snapshotRoot()).toEqual(before);
  });

  it('cases 1 and 2 answer with the earlier job\'s jobId', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: 'new-s', migration: 'job-contract-8', flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-contract-8', to: 'postgres', stage: 'env', storeId: 'new-s', startedAt: 1 });
    seedFile('.env', 'DATA_BACKEND=postgres\n');
    const service = serviceFor(new FakeDb(), new FakeHost());
    expect((await service.post({ jobId: 'job-contract-9', to: 'postgres' })).body).toMatchObject({ success: true, jobId: 'job-contract-8', to: 'postgres', state: 'done' });

    wipeRoot();
    writeJson(MARKER, { live: 'postgres', storeId: 'src-2', flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-contract-a', to: 'file', stage: 'switching', sourceStoreId: 'src-2', source: { host: 'db.example', port: 5432, database: 'smdb' }, startedAt: 1 });
    const db = new FakeDb();
    db.schemas.set('smdb_superseded_1', emptyStore('src-2'));
    const s2 = serviceFor(db, new FakeHost());
    expect((await s2.post({ jobId: 'job-contract-b', to: 'file' })).body).toMatchObject({ success: true, jobId: 'job-contract-a', to: 'file', state: 'done' });
  });
});

describe('the GET', () => {
  it('has the contract\'s shape, with destination on a Postgres destination', async () => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{}');
    const service = serviceFor(new FakeDb(), new FakeHost());
    expect(service.status().body).toEqual({ success: true, job: null });
    await service.post({ jobId: 'job-contract-c', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job).toMatchObject({ jobId: 'job-contract-c', state: 'done', to: 'postgres', stage: expect.any(String), destination: { host: 'db.example', port: 5432, database: 'smdb' }, envSwitched: true });
    expect(typeof job.startedAt).toBe('number');
    expect(typeof job.finishedAt).toBe('number');
    expect(job.counts).toMatchObject({ documents: 1, appendFiles: 0, graveyardEntries: 0 });
    expect(job.storeId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers { success: false, error } for an unreadable journal', () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    seedFile('.migration.json', '{"jobId": ');
    const service = serviceFor(new FakeDb(), new FakeHost());
    const g = service.status().body;
    expect(g.success).toBe(false);
    expect(g.error).toMatch(/can't confirm which store holds the data/);
  });
});
