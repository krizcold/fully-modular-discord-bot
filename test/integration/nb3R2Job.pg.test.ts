import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { normalizeAddress } from '../../src/bot/internalSetup/utils/dataMigration';
import {
  insertDoc, otherSession, provisionedStore, realService, resetDatabase, schemas, sessionsGone, startHop, startRig, stopRig, jsonBot, type Hop, type PgRig,
} from '../helpers/pgMigrationRig';
import { FakeHost, JOURNAL, MARKER, readJson, seedFile, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 code review round 2 against a real Postgres: OPS-3 (a job statement with no byte from the database is ended
// at its bound, through a TCP hop that drops the traffic) and OPS-4 (an earlier job's session still open).

let rig: PgRig;
let hop: Hop;
let hopUrl: string;
const G = '191919191919191919';
const NEXT_STEP = 'the database ends it once it notices the connection is gone; run the migration again once it no longer shows';

beforeAll(async () => {
  rig = await startRig();
  ({ hop, url: hopUrl } = await startHop(rig));
}, 180_000);
afterAll(async () => {
  await hop?.close();
  await stopRig(rig);
});
beforeEach(async () => {
  hop.restore();
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('NB3-R2-OPS-3: a job statement to a silent database', () => {
  it('to Postgres: the statements of S5 get no byte; the job fails at copying within the bound and releases the lock', async () => {
    useDatabaseUrl(hopUrl);
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    const host = new FakeHost();
    const service = realService(host, { answerBoundMs: 2000, closeBoundMs: 1000, fault: p => { if (p === 'S5') hop.stall(); } });
    const started = Date.now();
    await service.post({ jobId: 'job-r2pg-op3-01', to: 'postgres' });
    await service.idle();
    expect(Date.now() - started).toBeLessThan(20_000);
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying' });
    expect(job.error).toMatch(/^The \w+ got no answer from the database within 2 s$/);
    expect(host.lock).toBeNull();
    expect(readJson(MARKER).live).toBe('file');
    hop.restore();
    await sessionsGone(rig);
    expect(await schemas(rig)).toEqual([]);
  });

  it('to JSON: the read of S4 gets no byte; the job fails at reading and the source stays', async () => {
    useDatabaseUrl(hopUrl);
    const storeId = await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{"a":1}');
    const host = new FakeHost();
    const service = realService(host, { answerBoundMs: 2000, closeBoundMs: 1000, fault: p => { if (p === 'S4') hop.stall(); } });
    await service.post({ jobId: 'job-r2pg-op3-02', to: 'file' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job.error).toMatch(/got no answer from the database within 2 s$/);
    expect(host.lock).toBeNull();
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres', storeId });
    hop.restore();
    await sessionsGone(rig);
    expect(await schemas(rig)).toEqual(['smdb_data']);
  });

  it('the COMMIT keeps its own bound and its interrupted result', async () => {
    useDatabaseUrl(hopUrl);
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    const service = realService(new FakeHost(), { answerBoundMs: 1000, commitBoundMs: 3000, closeBoundMs: 1000, fault: p => { if (p === 'commit-send') hop.stall(); } });
    await service.post({ jobId: 'job-r2pg-op3-03', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job, why(service.status().body.job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL).error).toBe('The COMMIT got no answer within 3 s');
    hop.restore();
    await sessionsGone(rig);
  });
});

describe("NB3-R2-OPS-4: an earlier job's database session still open", () => {
  const address = () => normalizeAddress(rig.url);
  const OPEN = `migration job-r2pg-op4-old's database session is still open; ${NEXT_STEP}`;

  it('a move to Postgres that ended after S4 is case 4 while the session is open, and runs once it ends', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    writeJson(JOURNAL, { jobId: 'job-r2pg-op4-old', to: 'postgres', stage: 'rereading', result: 'failed', error: 'x', startedAt: 1, finishedAt: 2, destination: address() });
    const open: Client = await otherSession(rig, 'smdb-migrate:job-r2pg-op4-old');
    const host = new FakeHost();
    try {
      const answer = await realService(host).post({ jobId: 'job-r2pg-op4-new1', to: 'postgres' });
      expect(answer).toMatchObject({ status: 409, body: { success: false, error: `can't confirm; ${OPEN}`, jobId: 'job-r2pg-op4-old' } });
      expect(readJson(JOURNAL).jobId).toBe('job-r2pg-op4-old');
      expect(host.lock).toBeNull();
    } finally { await open.end(); }
    await sessionsGone(rig);
    const service = realService(host);
    const again = await service.post({ jobId: 'job-r2pg-op4-new2', to: 'postgres' });
    expect(again.body, why(again.body)).toMatchObject({ state: 'started' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ jobId: 'job-r2pg-op4-new2', state: 'done' });
  });

  it('S2 names the smdb-migrate session with the same next step', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    writeJson(JOURNAL, { jobId: 'job-r2pg-op4-old', to: 'postgres', stage: 'reading', result: 'failed', error: 'x', startedAt: 1, finishedAt: 2 });
    const open = await otherSession(rig, 'smdb-migrate:job-r2pg-op4-old');
    const service = realService(new FakeHost());
    try {
      await service.post({ jobId: 'job-r2pg-op4-new3', to: 'postgres' });
      await service.idle();
    } finally { await open.end(); }
    expect(service.status().body.job).toMatchObject({ state: 'failed', stage: 'checking', error: `Migration job-r2pg-op4-old's database session is still open; ${NEXT_STEP}` });
    expect(await schemas(rig)).toEqual([]);
  });
});
