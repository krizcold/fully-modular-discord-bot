import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 G5 cases 1 and 2 (finishing an earlier job whose copy is in place) and S10's marker write: the journal, the
// marker, /data/.env, the answer and the log lines each step leaves.

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

import { normalizeAddress } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials, resolveDataBackend } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { ENV, FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

const OLD = 'job-s7-old-01';
const ENV_UNFINISHED = 'The switch is made; run the migration again to finish the env';
const eio = (text = 'EIO: i/o error') => Object.assign(new Error(text), { code: 'EIO' });

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
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
});

/** An earlier move to Postgres whose marker landed: a POST of the same direction finishes it from the env step. */
function earlierToPg(extra: Record<string, unknown> = {}, env: string | null = 'DATA_BACKEND=file\n'): void {
  freshJsonBot();
  writeJson(MARKER, { live: 'postgres', storeId: 'copy-s7', flippedAt: 1, migration: OLD });
  writeJson(JOURNAL, {
    jobId: OLD, to: 'postgres', stage: 'env', result: 'done', startedAt: 1, finishedAt: 12345, storeId: 'copy-s7',
    destination: normalizeAddress(PG_URL), envSwitched: true, ...extra,
  });
  if (env !== null) fs.writeFileSync(ENV, env);
}

const post = (body: Record<string, unknown> = {}) => serviceFor(new FakeDb(), new FakeHost()).post({ jobId: 'job-s7-new-01', to: 'postgres', ...body });

describe('the address check of a finishing move to Postgres', () => {
  it('a bot without a manager checks DATA_BACKEND_URL, not an address in the request', async () => {
    earlierToPg({}, 'DATA_BACKEND=postgres\n');
    const answer = await post({ url: 'postgres://u:pw@other.example:5432/smdb' });
    expect(answer, why(answer)).toMatchObject({ status: 200, body: { success: true, jobId: OLD, state: 'done' } });
  });

  it('a managed bot with no address in the request checks DATA_BACKEND_URL', async () => {
    earlierToPg({}, 'DATA_BACKEND=postgres\n');
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'tok';
    const answer = await post();
    expect(answer, why(answer)).toMatchObject({ status: 200, body: { success: true, jobId: OLD, state: 'done', envSwitched: false } });
  });

  it('a DATA_BACKEND_URL with a trailing no-break space names the same database', async () => {
    earlierToPg({}, 'DATA_BACKEND=postgres\n');
    process.env.DATA_BACKEND_URL = PG_URL + String.fromCharCode(0xa0);
    const answer = await post();
    expect(answer, why(answer)).toMatchObject({ status: 200, body: { success: true, jobId: OLD, state: 'done' } });
  });

  it('a journal with no store id names the store unknown', async () => {
    earlierToPg({ storeId: undefined });
    delete process.env.DATA_BACKEND_URL;
    const answer = await post();
    expect(answer.body.error).toBe(`can't confirm; migration ${OLD} copied to db.example:5432/smdb (store unknown), and DATA_BACKEND_URL is not set`);
  });

  it('a move to JSON is finished without an address check, whatever destination its journal holds', async () => {
    freshJsonBot();
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1, migration: OLD });
    writeJson(JOURNAL, {
      jobId: OLD, to: 'file', stage: 'env', result: 'interrupted', startedAt: 1, sourceStoreId: 'src-s7',
      destination: normalizeAddress('postgres://u:pw@elsewhere.example:5432/other'),
    });
    fs.writeFileSync(ENV, 'DATA_BACKEND=postgres\n');
    const answer = await serviceFor(new FakeDb(), new FakeHost()).post({ jobId: 'job-s7-new-02', to: 'file' });
    expect(answer, why(answer)).toMatchObject({ status: 200, body: { success: true, jobId: OLD, to: 'file', state: 'done' } });
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=file\n');
  });
});

describe('the journal a finished job leaves', () => {
  it('a done journal whose env already matches is left byte for byte', async () => {
    earlierToPg({ envSwitched: undefined }, 'DATA_BACKEND=postgres\n');
    const before = fs.readFileSync(JOURNAL, 'utf-8');
    const answer = await post();
    expect(answer.body, why(answer.body)).toMatchObject({ success: true, jobId: OLD, state: 'done' });
    expect(fs.readFileSync(JOURNAL, 'utf-8')).toBe(before);
  });

  it('a done journal whose env is written again records envSwitched: true and keeps its finishedAt', async () => {
    earlierToPg({ envSwitched: false });
    await post();
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=postgres\n');
    expect(readJson(JOURNAL)).toMatchObject({ result: 'done', stage: 'env', finishedAt: 12345, envSwitched: true });
  });

  it('a journal interrupted at switching is finished at env: answer, journal, log and the backend read again', async () => {
    earlierToPg({ stage: 'switching', result: 'interrupted', error: 'x', finishedAt: 5 });
    expect(resolveDataBackend()).toBe('file');
    const seenAtEnvWrite: string[] = [];
    hook.atomic = (file, _contents, write) => {
      if (path.basename(file) === '.env') seenAtEnvWrite.push(readJson(JOURNAL).stage);
      write();
    };
    const answer = await post();
    expect(answer).toEqual({ status: 200, body: { success: true, jobId: OLD, to: 'postgres', state: 'done', stage: 'env', envSwitched: true } });
    expect(seenAtEnvWrite).toEqual(['env']);
    const j = readJson(JOURNAL);
    expect(j).toMatchObject({ result: 'done', stage: 'env', envSwitched: true });
    expect(j.error).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(`[Migration] Migration ${OLD} (--to postgres) is finished`);
    expect(resolveDataBackend()).toBe('postgres');
  });

  it('an env that already matches is not written and the stage stays where it was', async () => {
    earlierToPg({ stage: 'switching', result: 'interrupted', error: 'x', finishedAt: 5 }, 'DATA_BACKEND=postgres\n');
    const answer = await post();
    expect(answer.body).toEqual({ success: true, jobId: OLD, to: 'postgres', state: 'done', stage: 'switching', envSwitched: true });
    expect(readJson(JOURNAL)).toMatchObject({ result: 'done', stage: 'switching' });
  });

  it('a managed bot never writes /data/.env and answers envSwitched: false', async () => {
    earlierToPg({ stage: 'switching', result: 'interrupted', finishedAt: 5 });
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'tok';
    const answer = await post();
    expect(answer.body).toEqual({ success: true, jobId: OLD, to: 'postgres', state: 'done', stage: 'switching', envSwitched: false });
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=file\n');
    expect(readJson(JOURNAL)).toMatchObject({ result: 'done', envSwitched: false });
  });

  it('a done journal that cannot be written is logged, and the answer is still done', async () => {
    earlierToPg({ stage: 'switching', result: 'interrupted', finishedAt: 5 });
    hook.atomic = (file, contents, write) => {
      if (path.basename(file) === '.migration.json' && /"result": "done"/.test(contents)) throw eio();
      write();
    };
    const answer = await post();
    expect(answer.body).toMatchObject({ success: true, state: 'done', stage: 'env' });
    expect(console.error).toHaveBeenCalledWith(`[Migration] Migration ${OLD} is done, but its journal's done could not be written: EIO: i/o error`);
    expect(readJson(JOURNAL)).toMatchObject({ stage: 'env', result: 'interrupted' });
  });

  it('an env write that fails leaves the journal interrupted at env, answers so and logs both lines', async () => {
    earlierToPg({ envSwitched: false });
    hook.atomic = (file, _contents, write) => {
      if (path.basename(file) === '.env') throw eio();
      write();
    };
    const answer = await post();
    expect(answer).toEqual({ status: 200, body: { success: true, jobId: OLD, to: 'postgres', state: 'interrupted', stage: 'env', error: ENV_UNFINISHED } });
    expect(readJson(JOURNAL)).toMatchObject({ result: 'interrupted', stage: 'env', error: ENV_UNFINISHED });
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=file\n');
    expect(console.error).toHaveBeenCalledWith('[Migration] DATA_BACKEND in /data/.env could not be written: EIO: i/o error');
    expect(console.error).toHaveBeenCalledWith(`[Migration] Migration ${OLD} could not be finished at env: ${ENV_UNFINISHED}`);
  });
});

describe('a move to JSON finished from the switch', () => {
  it('the marker of a JSON bot names no store, whatever store id the journal holds', async () => {
    const db = new FakeDb();
    db.schemas.set('smdb_superseded_1', emptyStore('src-s7'));
    freshJsonBot();
    writeJson(MARKER, { live: 'postgres', storeId: 'src-s7', flippedAt: 1 });
    writeJson(JOURNAL, { jobId: OLD, to: 'file', stage: 'retire-source', result: 'interrupted', startedAt: 1, sourceStoreId: 'src-s7', storeId: 'stray-s7' });
    fs.writeFileSync(ENV, 'DATA_BACKEND=postgres\n');
    const answer = await serviceFor(db, new FakeHost()).post({ jobId: 'job-s7-new-03', to: 'file' });
    expect(answer.body, why(answer.body)).toMatchObject({ success: true, jobId: OLD, to: 'file', state: 'done' });
    expect(readJson(MARKER)).toMatchObject({ live: 'file', storeId: null, migration: OLD });
  });
});

describe('S10: the marker write of a job', () => {
  const G = '770000000000000001';
  const JOB = 'job-s7-mark-01';
  async function runJob(fault?: (point: string) => void) {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{"a":1}');
    const service = serviceFor(new FakeDb(), new FakeHost(), { fault });
    await service.post({ jobId: JOB, to: 'postgres' });
    await service.idle();
    return service.status().body.job;
  }

  it('a bundle import that starts before the switch stops it, naming every import', async () => {
    const job = await runJob(point => {
      if (point !== 'S10') return;
      fs.mkdirSync(path.join(root, '.bundle-import-a'));
      fs.mkdirSync(path.join(root, '.bundle-import-b'));
    });
    const named = fs.readdirSync(root).filter(n => n.startsWith('.bundle-import-')).map(n => path.join(root, n));
    expect(named).toHaveLength(2);
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'switching' });
    expect(job.error).toBe(`A bundle import is in progress (${named.join(', ')}); the marker was not switched`);
    expect(readJson(MARKER).live).toBe('file');
  });

  it.each([
    ['live', { live: 'file' }],
    ['storeId', { storeId: 'another-store' }],
    ['migration', { migration: 'job-s7-other' }],
  ])('a marker that reads back with another %s is not switched', async (_field, change) => {
    hook.atomic = (file, contents, write) => {
      if (path.basename(file) === '.backend.json' && contents.includes(JOB)) {
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(contents), ...change }, null, 2));
        return;
      }
      write();
    };
    const job = await runJob();
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'switching' });
    expect(job.error).toBe(`The marker could not be switched: ${MARKER} does not read back as written`);
  });

  it('a marker write that lands and then throws is logged and the job is done', async () => {
    hook.atomic = (file, contents, write) => {
      write();
      if (path.basename(file) === '.backend.json' && contents.includes(JOB)) throw eio('EIO: fsync of the folder failed');
    };
    const job = await runJob();
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(console.warn).toHaveBeenCalledWith(`[Migration] The marker write of migration ${JOB} reported an error, but the marker reads back as written: EIO: fsync of the folder failed`);
  });
});
