import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveStatus } from '../../src/bot/internalSetup/utils/dataMigration';
import { readDataFacts } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { FakeDb } from '../helpers/fakePg';
import { JOURNAL, MARKER, PG_URL, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson } from '../helpers/migrationRig';

const JOB = 'job-nb17-done01';
const UNNAMED = `can't confirm; migration ${JOB} says done, but /data/.backend.json does not name it`;

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const status = () => deriveStatus(readDataFacts(), { running: null, managed: true });
const doneJournal = () => writeJson(JOURNAL, { jobId: JOB, to: 'postgres', stage: 'env', result: 'done', storeId: 's1', startedAt: 1, finishedAt: 2 });

describe('a GET on a done journal', () => {
  it('answers done when the marker names the job', () => {
    writeJson(MARKER, { live: 'postgres', storeId: 's1', flippedAt: 1, migration: JOB });
    doneJournal();
    expect(status()).toMatchObject({ status: 200, body: { success: true, job: { jobId: JOB, state: 'done' } } });
  });

  it('answers the POST\'s can\'t-confirm refusal when the marker names another job', () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1, migration: 'job-nb17-other1' });
    doneJournal();
    expect(status()).toEqual({ status: 409, body: { success: false, error: UNNAMED, jobId: JOB, to: 'postgres' } });
  });

  it('never answers done when the marker is missing', () => {
    doneJournal();
    const answer = status();
    expect(answer.body.success).toBe(false);
    expect(answer.body.error).toMatch(/^can't confirm/);
  });

  it('never answers done when the marker is unreadable', () => {
    seedFile('.backend.json', '{ not json');
    doneJournal();
    const answer = status();
    expect(answer.body.success).toBe(false);
    expect(answer.body.error).toMatch(/can't confirm/);
  });

  it('gives the same answer as a POST for the same state', async () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1, migration: 'job-nb17-other1' });
    doneJournal();
    seedFile('.env', 'DATA_BACKEND=file\n');
    const get = status();
    const post = await serviceFor(new FakeDb()).post({ jobId: 'job-nb17-new001', to: 'postgres' });
    expect(get).toEqual(post);
  });

  it('refuses a POST that reuses the job\'s id in the other direction', async () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1, migration: 'job-nb17-other1' });
    doneJournal();
    seedFile('.env', 'DATA_BACKEND=file\n');
    const post = await serviceFor(new FakeDb()).post({ jobId: JOB, to: 'file' });
    expect(post).toEqual({ status: 409, body: { success: false, error: UNNAMED, jobId: JOB, to: 'postgres' } });
  });

  it('answers that the data is already on file for another job in the other direction', async () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1, migration: 'job-nb17-other1' });
    doneJournal();
    seedFile('.env', 'DATA_BACKEND=file\n');
    const post = await serviceFor(new FakeDb()).post({ jobId: 'job-nb17-new002', to: 'file' });
    expect(post).toEqual({ status: 409, body: { success: false, error: 'The data is already on file' } });
  });
});
