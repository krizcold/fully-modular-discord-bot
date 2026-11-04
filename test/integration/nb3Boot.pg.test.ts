import fs from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateRecognitionGuard, verifyStoreIdentity } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { insertDoc, jsonBot, provisionedStore, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, JOURNAL, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';
import { setBackendKind } from '../helpers/backendKind';

// NB3 decision 13: what the next boot serves after a migration.

let rig: PgRig;
const G = '292929292929292929';
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
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

async function run(to: 'postgres' | 'file', jobId: string, fault?: (p: string) => void) {
  const service = realService(new FakeHost(), { fault });
  await service.post({ jobId, to });
  await service.idle();
  return service.status().body.job;
}

describe('the next boot', () => {
  it('serves the destination after a move to Postgres; with the env left old it refuses with the guard\'s text', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const job = await run('postgres', 'job-boot-0001');
    expect(job?.state, why(job)).toBe('done');
    setBackendKind('postgres');
    expect(evaluateRecognitionGuard()).toEqual({ state: 'boot', live: 'postgres' });
    expect(await verifyStoreIdentity(rig.url, true)).toEqual({ ok: true });
    setBackendKind('file');
    expect((evaluateRecognitionGuard() as any).reason).toBe('Migration job-boot-0001 moved the data to postgres; set DATA_BACKEND to postgres, or run a migration');
  });

  it('in R it refuses before the backend opens, also with the journal unreadable or deleted, and creates no smdb_data', async () => {
    await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{}');
    const job = await run('file', 'job-boot-0002', p => { if (p === 'S10') throw die(); });
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'switching' });
    expect(await schemas(rig)).not.toContain('smdb_data');
    const { initDataBackendLayer, getDataBootStatus } = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
    setBackendKind('postgres');
    expect(evaluateRecognitionGuard().state).toBe('refused');
    initDataBackendLayer();
    expect(getDataBootStatus()).toMatchObject({ state: 'refused' });
    expect(getDataBootStatus().refusalReason).toMatch(/A migration is unfinished/);
    fs.writeFileSync(JOURNAL, '{');
    expect((evaluateRecognitionGuard() as any).reason).toMatch(/can't confirm which store holds the data/);
    initDataBackendLayer();
    expect(getDataBootStatus()).toMatchObject({ state: 'refused' });
    expect(getDataBootStatus().refusalReason).toMatch(/can't confirm which store holds the data/);
    fs.rmSync(JOURNAL);
    expect((evaluateRecognitionGuard() as any).reason).toMatch(/can't confirm which store holds the data/);
    initDataBackendLayer();
    expect(getDataBootStatus()).toMatchObject({ state: 'refused' });
    expect(getDataBootStatus().refusalReason).toMatch(/can't confirm which store holds the data/);
    await new Promise(r => setTimeout(r, 1500));
    expect(await schemas(rig)).not.toContain('smdb_data');
  });
});
