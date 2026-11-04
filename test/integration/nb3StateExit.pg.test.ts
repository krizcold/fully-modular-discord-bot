import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateRecognitionGuard, verifyStoreIdentity } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { insertDoc, jsonBot, provisionedStore, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, JOURNAL, MARKER, readJson, root, seedFile, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';
import { setBackendKind } from '../helpers/backendKind';

// NB3's state x exit table, the cells that need a database: E3 (the process dies) at S4 to S10, COMMIT on the wire,
// E8 (the database drops) at S0 and S4 to S9, E9 at S5, then the next POST and the next boot.

let rig: PgRig;
const G = '282828282828282828';
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

async function run(to: 'postgres' | 'file', jobId: string, fault?: (p: string) => void | Promise<void>) {
  const service = realService(new FakeHost(), { fault });
  const answer = await service.post({ jobId, to });
  await service.idle();
  return { answer, job: service.status().body.job };
}

async function terminateJobSessions(): Promise<void> {
  await rig.admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE 'smdb-migrate:%' AND pid <> pg_backend_pid()`);
}

describe('E3 on a Postgres source (S4 to S10): the transaction aborts with its session', () => {
  it.each(['S4', 'S5', 'S6', 'S7', 'S8', 'S9'])('at %s the source serves and a POST starts over', async point => {
    await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{}');
    const first = await run('file', 'job-se-00001', p => { if (p === point) throw die(); });
    expect(first.job?.state, why(first.job)).toBe('interrupted');
    await terminateJobSessions();
    expect(await schemas(rig)).toEqual(['smdb_data']);
    const again = await run('file', 'job-se-00002');
    expect(again.job, why(again.job)).toMatchObject({ jobId: 'job-se-00002', state: 'done' });
  }, 90_000);

  it('at S10 (after the rename\'s COMMIT) the guard refuses before the backend opens; a POST finishes it by case 2', async () => {
    await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{}');
    const first = await run('file', 'job-se-00003', p => { if (p === 'S10') throw die(); });
    expect(first.job, why(first.job)).toMatchObject({ state: 'interrupted', stage: 'switching' });
    setBackendKind('postgres');
    expect(evaluateRecognitionGuard().state).toBe('refused');
    setBackendKind(null);
    const again = await run('file', 'job-se-00004');
    expect(again.answer.body, why(again.answer.body)).toMatchObject({ jobId: 'job-se-00003', state: 'done' });
  }, 90_000);
});

describe('E3 on a Postgres destination at S8', () => {
  it('before the committing write: nothing in the database; after it with COMMIT on the wire: case 3 renames the copy aside', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const first = await run('postgres', 'job-se-00005', p => { if (p === 'before-commit') throw die(); });
    expect(first.job?.state, why(first.job)).toBe('interrupted');
    await terminateJobSessions();
    expect(await schemas(rig)).toEqual([]);
    const committed = await run('postgres', 'job-se-00006', p => { if (p === 'S10') throw die(); });
    expect(committed.job, why(committed.job)).toMatchObject({ state: 'interrupted', stage: 'switching' });
    expect(readJson(MARKER).live).toBe('file');
    const again = await run('postgres', 'job-se-00007');
    expect(again.job, why(again.job)).toMatchObject({ jobId: 'job-se-00007', state: 'done' });
    expect((await schemas(rig)).filter(s => s.startsWith('smdb_superseded_'))).toHaveLength(1);
  }, 90_000);
});

describe('E8, the database drops', () => {
  it('at S0 the classification cannot read it: case 4, nothing written', async () => {
    const id = await provisionedStore(rig);
    const u = new URL(rig.url);
    writeJson(JOURNAL, { jobId: 'job-se-00008', to: 'file', stage: 'retire-source', sourceStoreId: id, source: { host: u.hostname.toLowerCase(), port: Number(u.port), database: u.pathname.slice(1) }, startedAt: 1 });
    await stopRig(rig);
    try {
      const answer = await realService().post({ jobId: 'job-se-00009', to: 'file' });
      expect(answer.body?.error, why(answer.body)).toMatch(/^can't confirm/);
      expect(readJson(JOURNAL).jobId).toBe('job-se-00008');
    } finally {
      rig = await startRig();
    }
  }, 240_000);

  // The drop surfaces at the job's next statement on its session: on a move to JSON the session is idle at S6 and S7,
  // so those two rows are driven on a move to Postgres, where S6 reads the copy back and S8 rechecks at rereading.
  it.each([
    ['file', 'S4', 'reading'],
    ['file', 'S5', 'copying'],
    ['postgres', 'S6', 'verifying'],
    ['postgres', 'S7', 'rereading'],
    ['file', 'S8', 'placing'],
    ['file', 'S9', 'placing'],
  ] as const)('to %s at %s the job fails at %s and the source serves', async (to, point, stage) => {
    if (to === 'file') {
      await provisionedStore(rig);
      await insertDoc(rig, G, 'm', 'a.json', '{}');
    } else {
      jsonBot();
      seedFile(`${G}/m/a.json`, '{}');
    }
    const { job } = await run(to, 'job-se-00010', async p => { if (p === point) await terminateJobSessions(); });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage });
    expect(readJson(JOURNAL)).toMatchObject({ stage, result: 'failed' });
    expect(await schemas(rig)).toEqual(to === 'file' ? ['smdb_data'] : []);
    expect(readJson(MARKER).live).toBe(to === 'file' ? 'postgres' : 'file');
    expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
    if (to === 'postgres' || point === 'S9') expect(fs.readFileSync(path.join(root, G, 'm', 'a.json'), 'utf-8')).toBe('{}');
    if (to === 'file' && point !== 'S9') expect(fs.existsSync(path.join(root, G))).toBe(false);
  });
});

describe('E9 at S5', () => {
  it('a statement that raises 53100 fails the job at copying and leaves nothing', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const { job } = await run('postgres', 'job-se-00011', async p => {
      if (p !== 'S5') return;
      await rig.admin.query(`CREATE OR REPLACE FUNCTION public.nb3_full() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disk full' USING ERRCODE = '53100'; END $$`);
      await rig.admin.query(`DROP EVENT TRIGGER IF EXISTS nb3_full`);
      await rig.admin.query(`CREATE EVENT TRIGGER nb3_full ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.nb3_full()`);
    });
    await rig.admin.query(`DROP EVENT TRIGGER IF EXISTS nb3_full`);
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying' });
    expect(await schemas(rig)).toEqual([]);
  });
});

describe('the next boot', () => {
  it('serves the destination after each direction: guard and identity', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const there = await run('postgres', 'job-se-00012');
    expect(there.job?.state, why(there.job)).toBe('done');
    setBackendKind('postgres');
    expect(evaluateRecognitionGuard()).toEqual({ state: 'boot', live: 'postgres' });
    expect(await verifyStoreIdentity(rig.url, true)).toEqual({ ok: true });
    setBackendKind(null);
    await run('file', 'job-se-00013');
    setBackendKind('file');
    expect(evaluateRecognitionGuard()).toEqual({ state: 'boot', live: 'file' });
  }, 90_000);
});
