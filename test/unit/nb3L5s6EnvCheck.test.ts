import fs from 'fs';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials } from '../../src/utils/envLoader';
import { FakeDb } from '../helpers/fakePg';
import { ENV, FakeHost, JOURNAL, MARKER, PG_URL, readJson, root, seedFile, serviceFor, snapshotRoot, useDatabaseUrl, wipeRoot, writeJson } from '../helpers/migrationRig';

// NB3 G7 before a finishing step: /data must take a temp file (written, synced, closed, removed) and, on a bot
// without a manager, /data/.env must be readable. The earlier job here is a move to Postgres whose marker is
// switched, so the request only finishes it.

const JOB = 'job-c6-env0001';
const NEW = 'job-c6-new0001';
const isEnv = (p: unknown) => path.resolve(String(p)) === path.resolve(ENV);

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  writeJson(MARKER, { live: 'postgres', storeId: 's1', flippedAt: 1, migration: JOB });
  writeJson(JOURNAL, { jobId: JOB, to: 'postgres', stage: 'env', storeId: 's1', startedAt: 1 });
  seedFile('.env', 'DATA_BACKEND=postgres\n');
});
afterEach(() => {
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

const finish = () => serviceFor(new FakeDb(), new FakeHost()).post({ jobId: NEW, to: 'postgres' });
const probesLeft = () => fs.readdirSync(root).filter(n => n.startsWith('.migrate-probe-'));

/** Records the fd of the probe file and lets a test fail its write or its sync. */
function watchProbe(opts: { fullDisk?: boolean; syncFails?: boolean } = {}): { fd: () => number | undefined; closed: number[] } {
  let probeFd: number | undefined;
  const closed: number[] = [];
  const realOpen = fs.openSync;
  const realWrite = fs.writeFileSync;
  const realSync = fs.fsyncSync;
  const realClose = fs.closeSync;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
    const fd = (realOpen as any)(p, ...rest);
    if (/\.migrate-probe-/.test(String(p))) probeFd = fd;
    return fd;
  }) as any);
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: any, data: any, ...rest: any[]) => {
    // A full disk takes no byte, so only a write of zero bytes passes.
    if (opts.fullDisk && target === probeFd && String(data).length > 0) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return (realWrite as any)(target, data, ...rest);
  }) as any);
  vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: any) => {
    if (opts.syncFails && fd === probeFd) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    return realSync(fd);
  }) as any);
  vi.spyOn(fs, 'closeSync').mockImplementation(((fd: any) => {
    closed.push(fd);
    return realClose(fd);
  }) as any);
  syncBuiltinESMExports();
  return { fd: () => probeFd, closed };
}

describe('the temp file probe of /data', () => {
  it('a /data that takes the probe finishes the job, and the probe file is closed and gone', async () => {
    const probe = watchProbe();
    const answer = await finish();
    expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ success: true, jobId: JOB, state: 'done' });
    expect(probe.fd()).toBeTypeOf('number');
    expect(probe.closed).toContain(probe.fd());
    expect(probesLeft()).toEqual([]);
    expect(readJson(JOURNAL)).toMatchObject({ jobId: JOB, result: 'done' });
  });

  it('a full disk refuses naming /data and the error, leaves no probe file and finishes nothing', async () => {
    const before = snapshotRoot();
    watchProbe({ fullDisk: true });
    const answer = await finish();
    expect(answer.status).toBe(409);
    expect(answer.body.success).toBe(false);
    expect(answer.body.error).toMatch(/cannot take a temp file \(.*\.migrate-probe-.*\): ENOSPC: no space left on device$/);
    expect(answer.body.error.startsWith(`${process.env.DATA_DIR} cannot take a temp file`)).toBe(true);
    expect(probesLeft()).toEqual([]);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(snapshotRoot()).toEqual(before);
  });

  it('a probe that cannot be synced refuses and finishes nothing', async () => {
    const before = snapshotRoot();
    watchProbe({ syncFails: true });
    const answer = await finish();
    expect(answer.body.error).toMatch(/cannot take a temp file \(.*\): EIO: i\/o error, fsync$/);
    expect(probesLeft()).toEqual([]);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(snapshotRoot()).toEqual(before);
  });
});

describe('the read of /data/.env', () => {
  it('a bot with a manager does not need /data/.env, so an unreadable one does not stop the finish', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'token';
    fs.rmSync(ENV);
    fs.mkdirSync(ENV);
    const answer = await finish();
    expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ success: true, jobId: JOB, state: 'done', envSwitched: false });
  });

  it('the env is read again for the check, so an error from an earlier read does not refuse a readable one', async () => {
    fs.rmSync(ENV);
    fs.mkdirSync(ENV);
    loadCredentials();
    fs.rmdirSync(ENV);
    seedFile('.env', 'DATA_BACKEND=postgres\n');
    const answer = await finish();
    expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ success: true, jobId: JOB, state: 'done' });
  });

  function failEnvRead(nth: number, error: unknown): void {
    let reads = 0;
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (isEnv(p) && ++reads === nth) throw error;
      return (real as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
  }
  const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

  it('an env the credentials loader could not read refuses naming the file and the error', async () => {
    const before = snapshotRoot();
    failEnvRead(1, eacces());
    const answer = await finish();
    expect(answer).toEqual({ status: 409, body: { success: false, error: `${ENV} cannot be read: EACCES: permission denied`, jobId: JOB, to: 'postgres' } });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(snapshotRoot()).toEqual(before);
  });

  it('an env that fails the check\'s own read refuses naming the file and the error', async () => {
    const before = snapshotRoot();
    failEnvRead(2, eacces());
    const answer = await finish();
    expect(answer).toEqual({ status: 409, body: { success: false, error: `${ENV} cannot be read: EACCES: permission denied`, jobId: JOB, to: 'postgres' } });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(snapshotRoot()).toEqual(before);
  });

  it('a read that throws no error object refuses with what was thrown', async () => {
    failEnvRead(2, undefined);
    const answer = await finish();
    expect(answer.body.error).toBe(`${ENV} cannot be read: undefined`);
  });
});
