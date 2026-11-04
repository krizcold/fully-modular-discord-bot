import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 decision 13: the job's marker writer, the one-key env writer, the first checks of G7 and the cache reset.

const failAtomic = vi.hoisted(() => ({ match: null as RegExp | null, landThenThrow: null as RegExp | null }));
vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string) => {
      if (failAtomic.match?.test(file)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      real.atomicWriteFileSync(file, contents);
      if (failAtomic.landThenThrow?.test(file)) throw Object.assign(new Error('EIO: fsync of the folder failed'), { code: 'EIO' });
    },
  };
});

import { readDataFacts, writeMarkerStrict } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { loadCredentials, resetDataBackendCache, resolveDataBackend, writeEnvDataBackend } from '../../src/utils/envLoader';
import { FakeDb } from '../helpers/fakePg';
import { ENV, FakeHost, MARKER, PG_URL, readJson, root, seedFile, serviceFor, snapshotRoot, useDatabaseUrl, wipeRoot, freshJsonBot } from '../helpers/migrationRig';

const G = '990000000000000001';

beforeEach(() => {
  freshJsonBot();
  failAtomic.match = null;
  failAtomic.landThenThrow = null;
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  loadCredentials();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  delete process.env.DATA_BACKEND;
});

describe('the marker writer', () => {
  it('writes live, storeId, flippedAt and migration, and reads it back', () => {
    writeMarkerStrict({ live: 'postgres', storeId: 's1', flippedAt: 7, migration: 'job-marker-01' });
    expect(readJson(MARKER)).toEqual({ live: 'postgres', storeId: 's1', flippedAt: 7, migration: 'job-marker-01' });
  });

  it('throws when the write fails', () => {
    failAtomic.match = /\.backend\.json$/;
    expect(() => writeMarkerStrict({ live: 'file', storeId: null, flippedAt: 1, migration: 'job-marker-02' })).toThrow();
  });
});

describe('the env writer', () => {
  it('changes only DATA_BACKEND, keeps every other line, and writes through a temp file', () => {
    seedFile('.env', 'DISCORD_TOKEN=abc\n# a comment\nDATA_BACKEND=file\nDATA_BACKEND_URL=postgres://x@h/db\n');
    const rename = vi.spyOn(fs, 'renameSync');
    syncBuiltinESMExports();
    writeEnvDataBackend('postgres');
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DISCORD_TOKEN=abc\n# a comment\nDATA_BACKEND=postgres\nDATA_BACKEND_URL=postgres://x@h/db\n');
    expect(rename).toHaveBeenCalled();
  });

  it('adds the key when the file has none, and creates the file when there is none', () => {
    seedFile('.env', 'A=1');
    writeEnvDataBackend('file');
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('A=1\nDATA_BACKEND=file\n');
    fs.rmSync(ENV);
    writeEnvDataBackend('postgres');
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=postgres\n');
  });

  it('the cache reset makes resolveDataBackend read again', async () => {
    const real = await vi.importActual<typeof import('../../src/utils/envLoader')>('../../src/utils/envLoader');
    seedFile('.env', 'DATA_BACKEND=file\n');
    expect(real.resolveDataBackend()).toBe('file');
    writeEnvDataBackend('postgres');
    expect(real.resolveDataBackend()).toBe('file');
    resetDataBackendCache();
    expect(real.resolveDataBackend()).toBe('postgres');
    void resolveDataBackend;
  });
});

describe('the first checks of an unmanaged bot (S2)', () => {
  async function failedWith(compareDisk = true): Promise<string> {
    seedFile(`${G}/mod/a.json`, '{}');
    const before = compareDisk ? snapshotRoot() : {};
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-checks-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job.state).toBe('failed');
    expect(db.schemas.size).toBe(0);
    if (compareDisk) {
      const after = snapshotRoot();
      delete after['.migration.json'];
      delete before['.migration.json'];
      expect(after).toEqual(before);
    }
    return job.error;
  }

  it('a pinned DATA_BACKEND refuses, naming the key; a pinned DATA_BACKEND_URL does not', async () => {
    seedFile('.env', 'A=1\n');
    loadCredentials();
    seedFile('.env', 'A=1\n');
    loadCredentials();
    process.env.DATA_BACKEND = 'file';
    expect(await failedWith()).toMatch(/DATA_BACKEND/);
    delete process.env.DATA_BACKEND;
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{}');
    const service = serviceFor(new FakeDb(), new FakeHost());
    await service.post({ jobId: 'job-checks-02', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job.state).toBe('done');
  });

  it('credentialsReadError() set, or an unreadable /data/.env, refuses naming the path', async () => {
    seedFile('.env', 'DATA_BACKEND=file\n');
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(ENV)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (real as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    expect(await failedWith(false)).toContain(ENV);
  });

  it('a /data that takes no temp file refuses on a managed and an unmanaged bot', async () => {
    const real = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (/\.migrate-probe-/.test(String(p))) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      return (real as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    expect(await failedWith()).toContain(root);
    freshJsonBot();
    process.env.BOT_MANAGER_UPDATE_TOKEN = 't';
    expect(await failedWith()).toContain(root);
  });
});

describe('the env step (S11)', () => {
  it('a failed env write leaves interrupted at env; a POST of the same direction finishes it', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    seedFile('.env', 'DATA_BACKEND=file\n');
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost());
    failAtomic.match = /[\\/]\.env$/;
    await service.post({ jobId: 'job-env-00001', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'interrupted', stage: 'env', error: 'The switch is made; run the migration again to finish the env' });
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres', migration: 'job-env-00001' });
    failAtomic.match = null;
    const again = await service.post({ jobId: 'job-env-00002', to: 'postgres' });
    expect(again.body).toMatchObject({ success: true, jobId: 'job-env-00001', to: 'postgres', state: 'done' });
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=postgres\n');
    expect(service.status().body.job).toMatchObject({ jobId: 'job-env-00001', state: 'done' });
  });

  it('a managed bot\'s env is not written and the answer says envSwitched: false', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = 't';
    seedFile(`${G}/mod/a.json`, '{}');
    seedFile('.env', 'DATA_BACKEND=file\n');
    const service = serviceFor(new FakeDb(), new FakeHost());
    await service.post({ jobId: 'job-env-00003', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'done', envSwitched: false });
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=file\n');
  });

  it('after a marker write that throws, the reread goes on when the marker landed, and otherwise ends interrupted at switching', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    failAtomic.match = /\.backend\.json$/;
    const service = serviceFor(new FakeDb(), new FakeHost());
    await service.post({ jobId: 'job-marker-03', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'interrupted', stage: 'switching' });
    expect(readDataFacts()).toMatchObject({ ok: true, marker: { live: 'file' } });
    freshJsonBot();
    failAtomic.match = null;
    failAtomic.landThenThrow = /\.backend\.json$/;
    seedFile(`${G}/mod/a.json`, '{}');
    const second = serviceFor(new FakeDb(), new FakeHost());
    await second.post({ jobId: 'job-marker-04', to: 'postgres' });
    await second.idle();
    expect(second.status().body.job).toMatchObject({ state: 'done' });
  });
});
