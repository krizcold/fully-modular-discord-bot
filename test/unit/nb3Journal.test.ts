import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveStatus } from '../../src/bot/internalSetup/utils/dataMigration';
import { readDataFacts } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import {
  ENV, FakeHost, JOURNAL, MARKER, PG_URL, STORES, freshJsonBot, readJson, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson,
} from '../helpers/migrationRig';

// NB3 decision 14: the journal's stages and results, and the state the status read derives from it.

const G = '121212121212121212';

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const status = (running: { jobId: string } | null = null, managed = false) => deriveStatus(readDataFacts(), { running, managed });
const journal = (j: object) => writeJson(JOURNAL, { jobId: 'job-journal-01', startedAt: 1, ...j });
const marker = (m: object) => writeJson(MARKER, { flippedAt: 1, storeId: null, ...m });

describe('the derived state', () => {
  it('running while this process runs the job', () => {
    marker({ live: 'file' });
    journal({ to: 'postgres', stage: 'copying' });
    expect(status({ jobId: 'job-journal-01' }).body.job.state).toBe('running');
  });

  it('done from a done result, also with /data/.env changed afterwards', () => {
    marker({ live: 'postgres', storeId: 's', migration: 'job-journal-01' });
    journal({ to: 'postgres', stage: 'env', result: 'done', storeId: 's' });
    seedFile('.env', 'DATA_BACKEND=file\n');
    expect(status().body.job.state).toBe('done');
  });

  it('with the marker matching: interrupted at env while an unmanaged DATA_BACKEND does not read back, done otherwise', () => {
    marker({ live: 'postgres', storeId: 's', migration: 'job-journal-01' });
    journal({ to: 'postgres', stage: 'switching', result: 'failed', error: 'x', storeId: 's' });
    seedFile('.env', 'DATA_BACKEND=file\n');
    expect(status().body.job).toMatchObject({ state: 'interrupted', stage: 'env', error: 'The switch is made; run the migration again to finish the env' });
    expect(status(null, true).body.job.state).toBe('done');
    seedFile('.env', 'DATA_BACKEND=postgres\n');
    expect(status().body.job.state).toBe('done');
  });

  it('failed from a failed result at every stage, retire-source and switching included', () => {
    marker({ live: 'postgres', storeId: 'src' });
    for (const stage of ['checking', 'draining', 'reading', 'copying', 'verifying', 'rereading', 'placing', 'retire-source', 'switching']) {
      journal({ to: 'file', stage, result: 'failed', error: 'why' });
      expect(status().body.job, stage).toMatchObject({ state: 'failed', stage, error: 'why' });
    }
  });

  it('failed with nothing changed at checking with no result', () => {
    marker({ live: 'file' });
    journal({ to: 'postgres', stage: 'checking' });
    expect(status().body.job).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(status().body.job.error).toMatch(/nothing was changed/);
  });

  it('interrupted with an interrupted or missing result, by stage', () => {
    marker({ live: 'file' });
    for (const result of [undefined, 'interrupted']) {
      const r = result ? { result } : {};
      journal({ to: 'postgres', stage: 'committing', ...r });
      expect(status().body.job).toMatchObject({ state: 'interrupted', stage: 'committing' });
      expect(status().body.job.error).toMatch(/may have been written; a retry verifies/);
      journal({ to: 'postgres', stage: 'switching', error: 'disk gone', ...r });
      expect(status().body.job).toMatchObject({ state: 'interrupted', stage: 'switching', error: 'disk gone' });
      journal({ to: 'postgres', stage: 'copying', ...r });
      expect(status().body.job).toMatchObject({ state: 'interrupted', stage: 'copying' });
    }
    marker({ live: 'postgres', storeId: 'src' });
    journal({ to: 'file', stage: 'retire-source', sourceStoreId: 'src' });
    expect(status().body.job.error).toMatch(/can't confirm whether the old store was renamed aside/);
  });

  it('a journal that says failed at switching while the marker landed reads from the marker', () => {
    marker({ live: 'file', migration: 'job-journal-01' });
    journal({ to: 'file', stage: 'switching', result: 'failed', error: 'x' });
    seedFile('.env', 'DATA_BACKEND=file\n');
    expect(status().body.job.state).toBe('done');
  });

  it('a missing, unreadable or unparsable journal or marker answers { success: false } with "can\'t confirm which store holds the data"', () => {
    journal({ to: 'postgres', stage: 'copying' });
    const a = status();
    expect(a.body).toMatchObject({ success: false });
    expect(a.body.error).toMatch(/can't confirm which store holds the data/);
    marker({ live: 'file' });
    fs.writeFileSync(JOURNAL, 'not json');
    expect(status().body.success).toBe(false);
  });
});

describe('the stage writes against a fake client', () => {
  function journalWrites(): () => Array<{ stage: string; result?: string; storeId?: string }> {
    const seen: Array<{ stage: string; result?: string; storeId?: string }> = [];
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      real(from, to);
      if (String(to) === JOURNAL) {
        const j = readJson(JOURNAL);
        seen.push({ stage: j.stage, result: j.result, storeId: j.storeId });
      }
    }) as any);
    syncBuiltinESMExports();
    return () => seen;
  }

  it('committing is written after the store list, the journal\'s store id and the session recheck, right before COMMIT', async () => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{}');
    const db = new FakeDb();
    const order: string[] = [];
    db.fail = sql => {
      if (/pg_stat_activity/.test(sql)) {
        const listed: string[] = fs.existsSync(STORES) ? readJson(STORES).storeIds : [];
        const id = readJson(JOURNAL).storeId;
        order.push(`sessions(${readJson(JOURNAL).stage}, store ${id ?? '-'}, listed ${id !== undefined && listed.includes(id)})`);
      }
      if (/^COMMIT/.test(sql)) order.push(`commit(${readJson(JOURNAL).stage}, list ${fs.existsSync(`${process.env.DATA_DIR}/.stores.json`)})`);
      return undefined;
    };
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-journal-02', to: 'postgres' });
    await service.idle();
    const commitAt = order.findIndex(o => o.startsWith('commit'));
    expect(order[commitAt]).toBe('commit(committing, list true)');
    expect(order[commitAt - 1]).toMatch(/^sessions\(rereading, store [0-9a-f-]{36}, listed true\)$/);
  });

  it('retire-source is written after the lock and the rename, right before COMMIT', async () => {
    marker({ live: 'postgres', storeId: 'src-r' });
    const db = new FakeDb();
    db.schemas.set('smdb_data', { ...emptyStore('src-r'), data: [{ guild_id: G, module: 'm', filename: 'a.json', doc: '{}' }] });
    const order: string[] = [];
    db.fail = sql => {
      if (/^LOCK TABLE .* IN ACCESS EXCLUSIVE MODE/.test(sql)) order.push(`lock(${readJson(JOURNAL).stage})`);
      if (/^ALTER SCHEMA smdb_data RENAME/.test(sql)) order.push(`rename(${readJson(JOURNAL).stage})`);
      if (/^COMMIT/.test(sql)) order.push(`commit(${readJson(JOURNAL).stage})`);
      return undefined;
    };
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-journal-03', to: 'file' });
    await service.idle();
    expect(order.slice(-3)).toEqual(['lock(placing)', 'rename(placing)', 'commit(retire-source)']);
  });

  it('a lock timeout, a refused rename, a session found and a refused COMMIT write failed at rereading (S8) or placing (S9)', async () => {
    const cases: Array<[string, 'postgres' | 'file', (sql: string, app: string) => Error | undefined, string]> = [
      ['refused COMMIT at S8', 'postgres', sql => (/^COMMIT/.test(sql) ? Object.assign(new Error('could not serialize'), { code: '40001', severity: 'ERROR' }) : undefined), 'rereading'],
      ['lock timeout at S9', 'file', sql => (/ACCESS EXCLUSIVE/.test(sql) ? Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }) : undefined), 'placing'],
      ['refused rename at S9', 'file', sql => (/^ALTER SCHEMA/.test(sql) ? Object.assign(new Error('permission denied'), { code: '42501' }) : undefined), 'placing'],
      ['refused COMMIT at S9', 'file', sql => (/^COMMIT/.test(sql) ? Object.assign(new Error('could not serialize'), { code: '40001', severity: 'ERROR' }) : undefined), 'placing'],
    ];
    for (const [name, to, fail, stage] of cases) {
      wipeRoot();
      const db = new FakeDb();
      if (to === 'file') {
        marker({ live: 'postgres', storeId: 'src-f' });
        db.schemas.set('smdb_data', { ...emptyStore('src-f'), data: [{ guild_id: G, module: 'm', filename: 'a.json', doc: '{}' }] });
      } else {
        freshJsonBot();
        seedFile(`${G}/mod/a.json`, '{}');
      }
      db.fail = fail;
      const service = serviceFor(db, new FakeHost());
      await service.post({ jobId: 'job-journal-04', to });
      await service.idle();
      expect(service.status().body.job, name).toMatchObject({ state: 'failed', stage });
    }
  });

  it('a session found before committing writes failed at rereading', async () => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{}');
    const db = new FakeDb();
    let calls = 0;
    db.fail = sql => {
      if (/pg_stat_activity/.test(sql) && readJson(JOURNAL).stage === 'rereading' && calls++ === 0) db.sessions.push('bot-pool');
      return undefined;
    };
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-journal-05', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(db.schemas.has('smdb_data')).toBe(false);
  });

  it('a COMMIT with no answer writes interrupted at committing or retire-source', async () => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{}');
    const db = new FakeDb();
    db.fail = sql => (/^COMMIT/.test(sql) ? 'hang' : undefined);
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-journal-06', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-journal-06', stage: 'committing', result: 'interrupted' });
    wipeRoot();
    marker({ live: 'postgres', storeId: 'src-h' });
    const db2 = new FakeDb();
    db2.schemas.set('smdb_data', { ...emptyStore('src-h'), data: [{ guild_id: G, module: 'm', filename: 'a.json', doc: '{}' }] });
    db2.fail = (sql, app) => (/^COMMIT/.test(sql) && db2.statements(app).some(s => /^ALTER SCHEMA/.test(s)) ? 'hang' : undefined);
    const s2 = serviceFor(db2, new FakeHost());
    await s2.post({ jobId: 'job-journal-07', to: 'file' });
    await s2.idle();
    expect(s2.status().body.job).toMatchObject({ state: 'interrupted', stage: 'retire-source' });
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-journal-07', stage: 'retire-source', result: 'interrupted' });
  });

  it('a COMMIT the database answers with ROLLBACK writes failed at rereading (S8) or placing (S9) and keeps the old store', async () => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{}');
    const db = new FakeDb();
    db.fail = sql => (/^COMMIT/.test(sql) ? 'rollback' : undefined);
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-journal-09', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'failed', stage: 'rereading', error: 'The database rolled the transaction back at its COMMIT' });
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER).live).toBe('file');
    wipeRoot();
    marker({ live: 'postgres', storeId: 'src-rb' });
    const db2 = new FakeDb();
    db2.schemas.set('smdb_data', { ...emptyStore('src-rb'), data: [{ guild_id: G, module: 'm', filename: 'a.json', doc: '{}' }] });
    db2.fail = sql => (/^COMMIT/.test(sql) ? 'rollback' : undefined);
    const s2 = serviceFor(db2, new FakeHost());
    await s2.post({ jobId: 'job-journal-10', to: 'file' });
    await s2.idle();
    expect(s2.status().body.job).toMatchObject({ state: 'failed', stage: 'placing', error: 'The database rolled the transaction back at its COMMIT' });
    expect(db2.schemas.get('smdb_data')?.storeId).toBe('src-rb');
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres', storeId: 'src-rb' });
  });

  it('a statement error inside a transaction aborts it: later statements answer 25P02 and its COMMIT answers ROLLBACK', async () => {
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore('s'));
    const c = db.connect('t');
    await c.query('BEGIN');
    await expect(c.query(`SELECT value FROM smdb_missing.meta WHERE key = 'store_id'`)).rejects.toMatchObject({ code: '42P01' });
    await expect(c.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`)).rejects.toMatchObject({ code: '25P02' });
    expect((await c.query('COMMIT')).command).toBe('ROLLBACK');
    expect((await c.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`)).rows).toHaveLength(1);
  });

  it('every failure from S10 on writes interrupted', async () => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{}');
    const writes = journalWrites();
    const service = serviceFor(new FakeDb(), new FakeHost(), { fault: point => { if (point === 'S10') throw new Error('injected'); } });
    await service.post({ jobId: 'job-journal-08', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'interrupted', stage: 'switching' });
    expect(writes().at(-1)).toMatchObject({ stage: 'switching', result: 'interrupted' });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it('a web UI boot with an unfinished journal writes nothing', () => {
    marker({ live: 'file' });
    journal({ to: 'postgres', stage: 'copying' });
    const before = fs.readFileSync(JOURNAL, 'utf-8');
    serviceFor(new FakeDb(), new FakeHost());
    expect(fs.readFileSync(JOURNAL, 'utf-8')).toBe(before);
    expect(fs.existsSync(ENV)).toBe(false);
  });
});
