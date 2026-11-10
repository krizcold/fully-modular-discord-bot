import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDataFacts } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { setBackendKind } from '../helpers/backendKind';
import {
  FakeHost, JOURNAL, MARKER, PG_URL, STORES, freshJsonBot, readJson, seedFile, serviceFor, snapshotRoot, useDatabaseUrl, wipeRoot, writeJson,
} from '../helpers/migrationRig';

// NB3 decision 5: the source and the direction, G5's reader, and S0's order and classification.

const G = '141414141414141414';
const CANT = /can't confirm which store holds the data/;

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe("G5's reader", () => {
  it('a marker that does not exist, with no journal and no store list, reads as no marker', () => {
    expect(readDataFacts()).toEqual({ ok: true, marker: null, journal: null, storesExist: false });
  });

  it('refuses, naming the files, and leaves every file as it was', () => {
    const cases: Array<() => void> = [
      () => writeJson(JOURNAL, { jobId: 'job-dir-0001', to: 'postgres', stage: 'checking' }),
      () => writeJson(STORES, { storeIds: [] }),
      () => { writeJson(MARKER, { live: 'file' }); writeJson(STORES, { storeIds: [] }); },
      () => writeJson(MARKER, { live: 'file', migration: 'job-dir-0002' }),
      () => fs.writeFileSync(MARKER, 'nope'),
      () => writeJson(MARKER, { live: 'tape' }),
      () => { writeJson(MARKER, { live: 'file' }); writeJson(JOURNAL, { jobId: 'j', stage: 'checking' }); },
      () => fs.mkdirSync(MARKER),
    ];
    for (const seed of cases) {
      wipeRoot();
      seed();
      const before = snapshotRoot();
      const facts = readDataFacts();
      expect(facts.ok).toBe(false);
      expect((facts as any).reason).toMatch(CANT);
      expect((facts as any).reason).toMatch(/\.backend\.json|\.migration\.json/);
      expect(snapshotRoot()).toEqual(before);
    }
  });

  it('an unreadable marker (EACCES) refuses', () => {
    writeJson(MARKER, { live: 'file' });
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(MARKER)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (real as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    expect(readDataFacts().ok).toBe(false);
  });
});

describe('the source is the marker\'s, whatever DATA_BACKEND says', () => {
  it('DATA_BACKEND postgres with a file marker moves files to postgres', async () => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{}');
    setBackendKind('postgres');
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost());
    expect((await service.post({ jobId: 'job-dir-0003', to: 'postgres' })).body.state).toBe('started');
    await service.idle();
    expect(db.schemas.get('smdb_data')?.data).toHaveLength(1);
  });

  it('a request whose to the marker names refuses', async () => {
    freshJsonBot();
    const service = serviceFor(new FakeDb(), new FakeHost());
    const answer = await service.post({ jobId: 'job-dir-0004', to: 'file' });
    expect(answer.body).toMatchObject({ success: false, error: 'The data is already on file' });
  });
});

describe('a JSON bot that never booted', () => {
  it('writes the marker and migrates past S1', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost());
    expect((await service.post({ jobId: 'job-dir-0020', to: 'postgres' })).body.state).toBe('started');
    expect(fs.existsSync(JOURNAL)).toBe(true);
    await service.idle();
    expect(readJson(MARKER).live).toBe('postgres');
    expect(db.schemas.get('smdb_data')?.data).toHaveLength(1);
    const counts = db.log.map(e => e.sql).filter(sql => /pg_stat_activity/.test(sql) && /usesysid IS NOT NULL/.test(sql));
    expect(counts.length).toBeGreaterThan(0);
    for (const sql of counts) {
      expect(sql).toMatch(/datname = current_database\(\)/);
      expect(sql).not.toMatch(/backend_type =/);
    }
  });

  it('a failed marker write refuses, naming the file, and leaves no journal', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    const real = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p).includes('.backend.json')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return (real as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const answer = await service0().post({ jobId: 'job-dir-0021', to: 'postgres' });
    expect(answer.body).toMatchObject({ success: false });
    expect((answer.body as any).error).toMatch(/.backend.json/);
    expect(fs.existsSync(JOURNAL)).toBe(false);
    expect(fs.existsSync(MARKER)).toBe(false);
  });

  it('a marker absent beside a journal still refuses', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    writeJson(JOURNAL, { jobId: 'job-dir-0022', to: 'postgres', stage: 'checking', startedAt: 1 });
    const answer = await service0().post({ jobId: 'job-dir-0023', to: 'postgres' });
    expect((answer.body as any).error).toMatch(CANT);
    expect(fs.existsSync(MARKER)).toBe(false);
  });
});

function service0() {
  return serviceFor(new FakeDb(), new FakeHost());
}

describe("S0's order", () => {
  it('the lock is taken with no await before it, and the reader runs after it', async () => {
    freshJsonBot();
    const host = new FakeHost();
    const service = serviceFor(new FakeDb(), host);
    const pending = service.post({ jobId: 'job-dir-0005', to: 'postgres' });
    expect(host.lock).toEqual({ jobId: 'job-dir-0005', to: 'postgres' });
    await pending;
    await service.idle();
  });

  it('a URL list refuses', async () => {
    freshJsonBot();
    useDatabaseUrl('postgres://bot:pw@a:5432,b:5432/smdb');
    const service = serviceFor(new FakeDb(), new FakeHost());
    const answer = await service.post({ jobId: 'job-dir-0006', to: 'postgres' });
    await service.idle();
    const error = answer.body.success === false ? answer.body.error : service.status().body.job.error;
    expect(error).toMatch(/^DATA_BACKEND_URL lists 2 database addresses .*a migration needs one database address/);
  });
});

describe('the classification of the earlier journal', () => {
  it('case 1 answers done with the journal\'s jobId for any request jobId, finishes an unwritten env and writes a missing done', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: 's1', migration: 'job-case1-001', flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-case1-001', to: 'postgres', stage: 'env', storeId: 's1', destination: { host: 'db.example', port: 5432, database: 'smdb' }, startedAt: 1 });
    seedFile('.env', 'DATA_BACKEND=file\n');
    const service = serviceFor(new FakeDb(), new FakeHost());
    const answer = await service.post({ jobId: 'job-case1-999', to: 'postgres' });
    expect(answer.body).toMatchObject({ success: true, jobId: 'job-case1-001', state: 'done' });
    expect(fs.readFileSync(path.join(process.env.DATA_DIR as string, '.env'), 'utf-8')).toBe('DATA_BACKEND=postgres\n');
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-case1-001', result: 'done' });
  });

  it('a done journal whose marker does not match is case 4, never case 3', async () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-case4-001', to: 'postgres', stage: 'env', result: 'done', startedAt: 1 });
    const before = snapshotRoot();
    const answer = await serviceFor(new FakeDb(), new FakeHost()).post({ jobId: 'job-case4-002', to: 'postgres' });
    expect(answer.body.success).toBe(false);
    expect(answer.body.error).toMatch(/^can't confirm/);
    expect(snapshotRoot()).toEqual(before);
  });

  it('case 3 on a JSON source at committing or switching ends the earlier job failed and starts the request, also under the earlier jobId', async () => {
    for (const [stage, requestId] of [['committing', 'job-case3-new'], ['switching', 'job-case3-001']] as const) {
      freshJsonBot();
      seedFile(`${G}/mod/a.json`, '{}');
      writeJson(JOURNAL, { jobId: 'job-case3-001', to: 'postgres', stage, storeId: 'copy-1', startedAt: 1 });
      writeJson(STORES, { storeIds: ['copy-1'] });
      const db = new FakeDb();
      db.schemas.set('smdb_data', { ...emptyStore('copy-1'), data: [{ guild_id: G, module: 'mod', filename: 'a.json', doc: '{}' }] });
      const service = serviceFor(db, new FakeHost());
      const logged: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { logged.push(String(m)); });
      const writes: any[] = [];
      const real = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
        real(from, to);
        if (String(to) === JOURNAL) writes.push(readJson(JOURNAL));
      }) as any);
      syncBuiltinESMExports();
      const answer = await service.post({ jobId: requestId, to: 'postgres' });
      expect(answer.body, stage).toMatchObject({ success: true, jobId: requestId, state: 'started' });
      expect(logged.join('\n')).toContain('The old store was not retired; nothing was switched');
      expect(writes[0], stage).toMatchObject({ jobId: 'job-case3-001', stage, result: 'failed', error: 'The old store was not retired; nothing was switched' });
      expect(writes[1], stage).toMatchObject({ jobId: requestId, stage: 'checking' });
      expect(writes[1].result, stage).toBeUndefined();
      await service.idle();
      vi.mocked(fs.renameSync).mockRestore();
      syncBuiltinESMExports();
      expect(service.status().body.job).toMatchObject({ jobId: requestId, state: 'done' });
      expect([...db.schemas.keys()].some(k => k.startsWith('smdb_superseded_'))).toBe(true);
    }
  });

  it('an earlier failed result stands under case 3', async () => {
    freshJsonBot();
    writeJson(JOURNAL, { jobId: 'job-case3-002', to: 'postgres', stage: 'copying', result: 'failed', error: 'the first cause', startedAt: 1 });
    const writes: string[] = [];
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      real(from, to);
      if (String(to) === JOURNAL) writes.push(readJson(JOURNAL).error ?? '');
    }) as any);
    syncBuiltinESMExports();
    const service = serviceFor(new FakeDb(), new FakeHost());
    await service.post({ jobId: 'job-case3-003', to: 'postgres' });
    expect(writes[0]).toBe('');
    await service.idle();
  });

  it('before a finishing step a failed G7 check refuses naming it, and a destination address other than the journal\'s answers "can\'t confirm"', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: 's1', migration: 'job-fin-00001', flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-fin-00001', to: 'postgres', stage: 'env', storeId: 's1', destination: { host: 'other.host', port: 5432, database: 'smdb' }, startedAt: 1 });
    seedFile('.env', 'DATA_BACKEND=file\n');
    const before = snapshotRoot();
    const service = serviceFor(new FakeDb(), new FakeHost());
    const a = await service.post({ jobId: 'job-fin-00002', to: 'postgres' });
    expect(a.body.success).toBe(false);
    expect(a.body.error).toMatch(/^can't confirm/);
    expect(a.body.error).toContain('other.host');
    expect(a.body.error).toContain('s1');
    expect(snapshotRoot()).toEqual(before);
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (/\.migrate-probe-/.test(String(p))) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      return (realOpen as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    writeJson(JOURNAL, { jobId: 'job-fin-00001', to: 'postgres', stage: 'env', storeId: 's1', destination: { host: 'db.example', port: 5432, database: 'smdb' }, startedAt: 1 });
    const b = await service.post({ jobId: 'job-fin-00003', to: 'postgres' });
    expect(b.body.success).toBe(false);
    expect(b.body.error).toContain(process.env.DATA_DIR as string);
  });

  it('a superseded schema whose meta cannot be read does not hide the one that holds the source store (case 2)', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: 'src-1', flippedAt: 1 });
    writeJson(JOURNAL, {
      jobId: 'job-sup-00001', to: 'file', stage: 'switching', result: 'interrupted', error: 'x', startedAt: 1,
      sourceStoreId: 'src-1', source: { host: 'db.example', port: 5432, database: 'smdb' },
    });
    seedFile('.env', 'DATA_BACKEND=postgres\n');
    const db = new FakeDb();
    db.schemas.set('smdb_superseded_100', { ...emptyStore(null), noMeta: true });
    db.schemas.set('smdb_superseded_200', emptyStore('src-1'));
    const answer = await serviceFor(db, new FakeHost()).post({ jobId: 'job-sup-00002', to: 'file' });
    expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ success: true, jobId: 'job-sup-00001', state: 'done' });
    expect(readJson(MARKER)).toMatchObject({ live: 'file', migration: 'job-sup-00001' });
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-sup-00001', result: 'done' });
  });

  it('a request of the other to with the journal\'s jobId answers that job; an unfinished one of the other to is named by a refusal', async () => {
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-other-001', to: 'file', stage: 'switching', result: 'interrupted', error: 'x', startedAt: 1, sourceStoreId: 'z' });
    const service = serviceFor(new FakeDb(), new FakeHost());
    expect((await service.post({ jobId: 'job-other-001', to: 'postgres' })).body).toMatchObject({ jobId: 'job-other-001', to: 'file', state: 'interrupted', stage: 'switching' });
    writeJson(MARKER, { live: 'postgres', storeId: 'z', flippedAt: 1 });
    writeJson(JOURNAL, { jobId: 'job-other-002', to: 'file', stage: 'copying', startedAt: 1 });
    const r = await service.post({ jobId: 'job-other-003', to: 'postgres' });
    expect(r.body).toMatchObject({ success: false, jobId: 'job-other-002', to: 'file' });
    expect(r.body.error).toBe('The data is already on postgres; migration job-other-002 (--to file) is unfinished at copying; run it again with --to file');
  });
});
