import fs from 'fs';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Client, Pool } from 'pg';
import { evaluateRecognitionGuard } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { insertAppend, insertDoc, provisionedStore, realService, resetDatabase, schemas, sessionsGone, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { ENV, FakeHost, JOURNAL, MARKER, readJson, root, snapshotRoot, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';
import { setBackendKind } from '../helpers/backendKind';

// NB3 decisions 5 and 13: the source's retirement on a move to JSON, and what a later POST finds.

let rig: PgRig;
const G = '191919191919191919';
const die = () => Object.assign(new Error('the process died'), { simulateDeath: true });

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  setBackendKind(null);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

async function source(): Promise<string> {
  const id = await provisionedStore(rig);
  await insertDoc(rig, G, 'm', 'a.json', '﻿{"a":1}\r\n');
  await insertAppend(rig, G, 'm', 'log.jsonl', 'one\n');
  await insertAppend(rig, G, 'm', 'log.jsonl', 'two\n');
  return id;
}

/** An event trigger that makes every ALTER SCHEMA fail, so the rename aside is refused by the database itself. */
async function blockSchemaRenames(): Promise<void> {
  await rig.admin.query(`CREATE OR REPLACE FUNCTION public.smdb_test_block_rename() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'schema renames are blocked by the test'; END $$`);
  await rig.admin.query(`CREATE EVENT TRIGGER smdb_test_block_rename ON ddl_command_start WHEN TAG IN ('ALTER SCHEMA') EXECUTE FUNCTION public.smdb_test_block_rename()`);
}

async function unblockSchemaRenames(): Promise<void> {
  await rig.admin.query('DROP EVENT TRIGGER IF EXISTS smdb_test_block_rename');
  await rig.admin.query('DROP FUNCTION IF EXISTS public.smdb_test_block_rename()');
}

async function move(jobId: string, fault?: (p: string) => void | Promise<void>) {
  const service = realService(new FakeHost(), { fault });
  const answer = await service.post({ jobId, to: 'file' });
  await service.idle();
  return { answer, service, job: service.status().body.job };
}

describe('the retirement', () => {
  it('renames smdb_data aside with every row and its store id, before the marker; a pool session of the bot fails its next query', async () => {
    const id = await source();
    const pool = new Pool({ connectionString: rig.url, max: 1, application_name: 'smdb-webui-reader', statement_timeout: 30_000, idle_in_transaction_session_timeout: 10_000 });
    pool.on('error', () => undefined);
    onTestFinished(() => pool.end().catch(() => undefined));
    await pool.query('SELECT count(*) FROM smdb_data.guild_data');
    const markerAtCommit: string[] = [];
    const { job } = await move('job-retire-01', p => { if (p === 'after-retire-commit') markerAtCommit.push(readJson(MARKER).live); });
    expect(job?.state, why(job)).toBe('done');
    expect(markerAtCommit).toEqual(['postgres']);
    const names = await schemas(rig);
    expect(names).not.toContain('smdb_data');
    const sup = names.find(n => n.startsWith('smdb_superseded_'))!;
    expect(JSON.parse((await rig.admin.query(`SELECT value FROM "${sup}".meta WHERE key = 'store_id'`)).rows[0].value)).toBe(id);
    expect((await rig.admin.query(`SELECT doc FROM "${sup}".guild_data`)).rows[0].doc).toBe('﻿{"a":1}\r\n');
    await expect(pool.query('SELECT count(*) FROM smdb_data.guild_data')).rejects.toThrow(/does not exist/);
    expect(fs.readFileSync(path.join(root, G, 'm', 'a.json'), 'utf-8')).toBe('﻿{"a":1}\r\n');
    expect(fs.readFileSync(path.join(root, G, 'm', 'log.jsonl'), 'utf-8')).toBe('one\ntwo\n');
  });

  it('retire-source is written after the ACCESS EXCLUSIVE lock and the rename and before COMMIT', async () => {
    await source();
    const seen: string[] = [];
    await move('job-retire-02', async p => {
      if (p !== 'before-retire-commit') return;
      seen.push(readJson(JOURNAL).stage);
      const { rows } = await rig.admin.query(`SELECT mode FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE a.application_name = 'smdb-migrate:job-retire-02' AND l.mode = 'AccessExclusiveLock' LIMIT 1`);
      seen.push(rows[0]?.mode ?? 'none');
    });
    expect(seen).toEqual(['retire-source', 'AccessExclusiveLock']);
  });

  it('a lock past lock_timeout, a refused rename and a failed retire-source write roll back and end failed at placing, with smdb_data serving and every folder in place', async () => {
    const counts = async () => (await rig.admin.query(
      `SELECT (SELECT count(*) FROM smdb_data.guild_data)::int AS docs, (SELECT count(*) FROM smdb_data.guild_append)::int AS appends`)).rows[0];
    for (const how of ['lock', 'rename', 'write', 'write-all'] as const) {
      wipeRoot();
      await resetDatabase(rig);
      const id = await source();
      let holder: Client | null = null;
      if (how === 'lock') {
        holder = new Client({ connectionString: rig.url, application_name: 'smdb-webui-reader' });
        await holder.connect();
      }
      let refusing = false;
      if (how === 'write' || how === 'write-all') {
        const real = fs.renameSync;
        vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
          if (path.resolve(String(to)) === path.resolve(JOURNAL)) {
            if (!refusing && JSON.parse(fs.readFileSync(from, 'utf-8')).stage === 'retire-source') refusing = true;
            if (refusing) {
              if (how === 'write') refusing = JSON.parse(fs.readFileSync(from, 'utf-8')).stage === 'retire-source';
              if (refusing) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
            }
          }
          real(from, to);
        }) as any);
        syncBuiltinESMExports();
      }
      try {
        const { job } = await move(`job-retire-${how}`, async p => {
          if (how === 'lock' && p === 'S9') {
            await holder!.query('BEGIN');
            await holder!.query('SELECT count(*) FROM smdb_data.guild_data');
          }
          if (how === 'rename' && p === 'S9') await blockSchemaRenames();
        });
        await holder?.query('ROLLBACK').catch(() => undefined);
        await (holder as Client | null)?.end();
        if (how === 'rename') await unblockSchemaRenames();
        if (how === 'write' || how === 'write-all') {
          vi.mocked(fs.renameSync).mockRestore();
          syncBuiltinESMExports();
        }
        const expected = how === 'write-all' ? { state: 'interrupted', stage: 'placing' } : { state: 'failed', stage: 'placing' };
        expect(job, `${how} ${why(job)}`).toMatchObject(expected);
        if (how === 'write-all') expect(readJson(JOURNAL), how).toMatchObject({ stage: 'placing' });
        if (how === 'write-all') expect(readJson(JOURNAL).result, how).toBeUndefined();
        expect(await schemas(rig), how).toEqual(['smdb_data']);
        expect(JSON.parse((await rig.admin.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`)).rows[0].value), how).toBe(id);
        expect(await counts(), how).toEqual({ docs: 1, appends: 2 });
        expect(fs.readFileSync(path.join(root, G, 'm', 'a.json'), 'utf-8'), how).toBe('\ufeff{"a":1}\r\n');
        expect(fs.readFileSync(path.join(root, G, 'm', 'log.jsonl'), 'utf-8'), how).toBe('one\ntwo\n');
        setBackendKind('postgres');
        expect(evaluateRecognitionGuard(), how).toEqual({ state: 'boot', live: 'postgres' });
        setBackendKind(null);
      } finally {
        await unblockSchemaRenames();
        vi.restoreAllMocks();
        syncBuiltinESMExports();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
      }
    }
  }, 90_000);

  it('a failure after the COMMIT and before the marker: refused boot before the backend opens; a POST with a new jobId finds case 2', async () => {
    await source();
    const first = await move('job-retire-03', p => { if (p === 'S10') throw die(); });
    expect(first.job, why(first.job)).toMatchObject({ state: 'interrupted', stage: 'switching' });
    expect(readJson(MARKER).live).toBe('postgres');
    setBackendKind('postgres');
    expect((evaluateRecognitionGuard() as any).reason).toMatch(/A migration is unfinished/);
    const { initDataBackendLayer, getDataBootStatus } = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
    initDataBackendLayer();
    expect(getDataBootStatus()).toMatchObject({ state: 'refused' });
    expect(getDataBootStatus().refusalReason).toMatch(/A migration is unfinished/);
    await new Promise(r => setTimeout(r, 1500));
    expect(await schemas(rig)).not.toContain('smdb_data');
    setBackendKind(null);
    await sessionsGone(rig);
    const service = realService();
    const answer = await service.post({ jobId: 'job-retire-04', to: 'file' });
    expect(answer.body, why(answer.body)).toMatchObject({ success: true, jobId: 'job-retire-03', state: 'done' });
    expect(readJson(MARKER)).toMatchObject({ live: 'file', migration: 'job-retire-03' });
    expect(fs.readFileSync(ENV, 'utf-8')).toMatch(/^DATA_BACKEND=file$/m);
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-retire-03', result: 'done' });
  }, 90_000);

  it('the process killed after the retire-source write and before COMMIT: smdb_data in place; a POST finds case 3', async () => {
    await source();
    const first = await move('job-retire-05', p => { if (p === 'before-retire-commit') throw die(); });
    expect(first.job, why(first.job)).toMatchObject({ state: 'interrupted', stage: 'retire-source' });
    await new Promise(r => setTimeout(r, 500));
    expect(await schemas(rig)).toContain('smdb_data');
    const service = realService();
    const answer = await service.post({ jobId: 'job-retire-05', to: 'file' });
    expect(answer.body, why(answer.body)).toMatchObject({ success: true, jobId: 'job-retire-05', state: 'started' });
    await service.idle();
    expect(service.status().body.job, why(service.status().body.job)).toMatchObject({ jobId: 'job-retire-05', state: 'done' });
    const aside = fs.readdirSync(path.join(root, '_superseded')).filter(n => n.endsWith('-job-retire-05'))
      .map(n => path.join(root, '_superseded', n, G, 'm', 'a.json')).filter(f => fs.existsSync(f));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(aside[0], 'utf-8')).toBe('\ufeff{"a":1}\r\n');
    expect(fs.readFileSync(path.join(root, G, 'm', 'a.json'), 'utf-8')).toBe('\ufeff{"a":1}\r\n');
  }, 90_000);
});

describe('the classification answers "can\'t confirm" and writes nothing', () => {
  async function journalAt(sourceStoreId: string, source: object) {
    writeJson(JOURNAL, { jobId: 'job-cc-00001', to: 'file', stage: 'retire-source', sourceStoreId, source, startedAt: 1 });
  }
  const addr = () => { const u = new URL(rig.url); return { host: u.hostname, port: Number(u.port), database: u.pathname.slice(1) }; };

  it('when neither schema holds the source id, when both do, and when DATA_BACKEND_URL names another database', async () => {
    await source();
    await journalAt('not-this-store', addr());
    let before = snapshotRoot();
    expect((await realService().post({ jobId: 'job-cc-00002', to: 'file' })).body.error).toMatch(/^can't confirm/);
    expect(snapshotRoot()).toEqual(before);

    const id = JSON.parse((await rig.admin.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`)).rows[0].value);
    await rig.admin.query(`CREATE SCHEMA smdb_superseded_1`);
    await rig.admin.query(`CREATE TABLE smdb_superseded_1.meta (key text PRIMARY KEY, value text NOT NULL)`);
    await rig.admin.query(`INSERT INTO smdb_superseded_1.meta VALUES ('store_id', $1)`, [JSON.stringify(id)]);
    await journalAt(id, addr());
    before = snapshotRoot();
    expect((await realService().post({ jobId: 'job-cc-00003', to: 'file' })).body.error).toMatch(/^can't confirm/);
    expect(snapshotRoot()).toEqual(before);

    await journalAt(id, { ...addr(), database: 'elsewhere' });
    expect((await realService().post({ jobId: 'job-cc-00004', to: 'file' })).body.error).toMatch(/^can't confirm/);
  });

  it('addresses differing only in host case, an absent port against 5432, or a trailing slash compare equal', async () => {
    const { normalizeAddress, sameAddress } = await import('../../src/bot/internalSetup/utils/dataMigration');
    expect(sameAddress(normalizeAddress('postgres://u:p@DB.Example/smdb/'), normalizeAddress('postgres://u:p@db.example:5432/smdb'))).toBe(true);
  });

  it('when the database cannot be read, and a refused login answers "The database refused the bot\'s login"', async () => {
    const id = await source();
    await journalAt(id, addr());
    const u = new URL(rig.url);
    u.port = '1';
    useDatabaseUrl(u.toString());
    await journalAt(id, { ...addr(), port: 1 });
    expect((await realService().post({ jobId: 'job-cc-00005', to: 'file' })).body.error).toMatch(/^can't confirm/);
    useDatabaseUrl(rig.url);
    await rig.admin.query(`ALTER ROLE "${rig.container.getUsername()}" NOLOGIN`).catch(() => undefined);
    await journalAt(id, addr());
    const answer = await realService().post({ jobId: 'job-cc-00006', to: 'file' });
    await rig.admin.query(`ALTER ROLE "${rig.container.getUsername()}" LOGIN`).catch(() => undefined);
    expect(answer.body?.error, why(answer.body)).toMatch(/The database refused the bot's login/);
  });
});
