import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { BotManager } from '../../src/webui/botManager';
import { jsonBot, provisionedStore, realService, resetDatabase, schemas, sessionsGone, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, root, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';
import { setBackendKind } from '../helpers/backendKind';
import { seedShared, sharedOpts } from '../helpers/nb6MigrateRig';

// NB6 test 42: rows 117 and 118 against a real Postgres. S3 waits for the web UI's shared writes (decision 39), and a
// Postgres source's SHARE lock holds another session's shared write until the retirement, after which it fails.

let rig: PgRig;
const G = '424242424242424201';

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  _resetRowQueue();
  setBackendKind(null);
  await resetDatabase(rig);
  await sessionsGone(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  _resetRowQueue();
  setBackendKind(null);
});

/** BotManager's own answer for S3's wait, read from this process's row queue. */
class RealSharedHost extends FakeHost {
  sharedWritesSettled(): boolean {
    return BotManager.prototype.sharedWritesSettled.call(undefined);
  }
}

describe('row 117: S3 and the web UI\'s shared writes', () => {
  it('a row op of this process not yet stored refuses the job after the wait, with nothing in the database', async () => {
    jsonBot();
    seedShared(G);
    setBackendKind('postgres');
    expect(saveDataTracked('queued.json', { scope: 'global', category: 'm' }, { q: 1 }).outcome).toBe('saved');
    setBackendKind(null);
    const service = realService(new RealSharedHost(), { ...sharedOpts, sharedWaitMs: 500 });
    await service.post({ jobId: 'job-nb6dr-117-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'draining' });
    expect(job.error).toBe('A change to the shared files is still being saved; run the migration once it ends');
    expect(await schemas(rig)).toEqual([]);
  });

  it('a mark cleared within the wait lets the job go on and copy', async () => {
    jsonBot();
    seedShared(G);
    const host = new FakeHost();
    host.sharedMark = true;
    setTimeout(() => { host.sharedMark = false; }, 300);
    const service = realService(host, { ...sharedOpts, sharedWaitMs: 10_000 });
    await service.post({ jobId: 'job-nb6dr-117-02', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job, why(service.status().body.job)).toMatchObject({ state: 'done' });
    const { rows } = await rig.admin.query('SELECT count(*)::int AS n FROM smdb_data.shared_docs');
    expect(rows[0].n).toBe(5);
  });
});

describe('row 118: another session\'s shared write after S3 on a Postgres source', () => {
  it('waits on the SHARE lock until the retirement, then fails, landing nowhere', async () => {
    await provisionedStore(rig);
    let writer: Client | null = null;
    let late: Promise<unknown> | null = null;
    let settledAt = 0;
    let commitSentAt = 0;
    let pendingAtCommit = false;
    const service = realService(new FakeHost(), {
      ...sharedOpts,
      fault: async p => {
        if (p === 'retire-commit-send') {
          commitSentAt = Date.now();
          pendingAtCommit = settledAt === 0;
          return;
        }
        if (p !== 'S5') return;
        writer = new Client({ connectionString: rig.url, application_name: 'smdb-webui-reader' });
        await writer.connect();
        late = writer.query(`INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by) VALUES ('global/m/late.json', '\\x7b7d'::bytea, 'x', 1, 'other')`)
          .then(() => 'landed', (e: Error) => e)
          .finally(() => { settledAt = Date.now(); });
        await new Promise(r => setTimeout(r, 300));
      },
    });
    await service.post({ jobId: 'job-nb6dr-118-01', to: 'file' });
    await service.idle();
    expect(service.status().body.job?.state, why(service.status().body.job)).toBe('done');
    const outcome = await late;
    await (writer as Client | null)?.end();
    expect(outcome).toBeInstanceOf(Error);
    expect(pendingAtCommit).toBe(true);
    expect(settledAt).toBeGreaterThanOrEqual(commitSentAt);
    expect(['3F000', '42P01']).toContain((outcome as unknown as { code?: string }).code);
    expect(fs.existsSync(path.join(root, 'global', 'm', 'late.json'))).toBe(false);
    const retired = (await schemas(rig)).filter(s => s.startsWith('smdb_superseded_'));
    const none = await rig.admin.query(`SELECT count(*)::int AS n FROM "${retired[0]}".shared_docs WHERE key = 'global/m/late.json'`);
    expect(none.rows[0].n).toBe(0);
  });
});
