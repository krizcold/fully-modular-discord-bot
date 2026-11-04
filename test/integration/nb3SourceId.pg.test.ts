import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertDoc, provisionedStore, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, MARKER, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 decision 5: a Postgres source's store id must be the marker's.

let rig: PgRig;
const G = '202020202020202020';

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

async function run(fault?: (p: string) => void | Promise<void>) {
  const service = realService(new FakeHost(), { fault });
  await service.post({ jobId: 'job-srcid-001', to: 'file' });
  await service.idle();
  return service.status().body.job;
}

describe('the source store id', () => {
  it('a store id other than the marker\'s, or a marker with none, refuses at S2 naming both', async () => {
    const id = await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{}');
    writeJson(MARKER, { live: 'postgres', storeId: 'another-store', flippedAt: 1 });
    let job = await run();
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job?.error, why(job)).toContain(id);
    expect(job?.error, why(job)).toContain('another-store');
    wipeRoot();
    writeJson(MARKER, { live: 'postgres', storeId: null, flippedAt: 1 });
    job = await run();
    expect(job?.state, why(job)).toBe('failed');
    expect(job?.error, why(job)).toContain(id);
    expect(await schemas(rig)).toEqual(['smdb_data']);
  }, 90_000);

  it('a store that changes between S2 and S4 refuses inside the read transaction', async () => {
    await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{}');
    const job = await run(async p => {
      if (p === 'S3') await rig.admin.query(`UPDATE smdb_data.meta SET value = $1 WHERE key = 'store_id'`, [JSON.stringify('swapped-store')]);
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job?.error, why(job)).toContain('swapped-store');
  });
});
