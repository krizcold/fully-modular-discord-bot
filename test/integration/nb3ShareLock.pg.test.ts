import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { insertDoc, provisionedStore, realService, resetDatabase, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, root, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB3 decisions 4 and 13: the SHARE lock on a Postgres source.

let rig: PgRig;
const G = '181818181818181818';

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

describe('a Postgres source moving to JSON', () => {
  it('a write committed before the lock is in the copy; one started during the job waits for the retirement and then fails, landing nowhere', async () => {
    await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'before.json', '{"b":1}');
    let writer: Client | null = null;
    let late: Promise<unknown> | null = null;
    let settledAt = 0;
    let commitSentAt = 0;
    let pendingAtCommit = false;
    const service = realService(new FakeHost(), {
      fault: async p => {
        if (p === 'retire-commit-send') {
          commitSentAt = Date.now();
          pendingAtCommit = settledAt === 0;
          return;
        }
        if (p !== 'S5') return;
        writer = new Client({ connectionString: rig.url, application_name: 'smdb-webui-reader' });
        await writer.connect();
        late = writer.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, 'm', 'late.json', '{}')`, [G])
          .then(() => 'landed', (e: Error) => e)
          .finally(() => { settledAt = Date.now(); });
        await new Promise(r => setTimeout(r, 300));
      },
    });
    await service.post({ jobId: 'job-share-0001', to: 'file' });
    await service.idle();
    expect(service.status().body.job?.state, why(service.status().body.job)).toBe('done');
    const outcome = await late;
    await (writer as Client | null)?.end();
    expect(outcome).toBeInstanceOf(Error);
    expect(pendingAtCommit).toBe(true);
    expect(commitSentAt).toBeGreaterThan(0);
    expect(settledAt).toBeGreaterThanOrEqual(commitSentAt);
    // The name is looked up again once the lock is granted: the schema smdb_data no longer exists (3F000); a
    // server that resolves the schema but not the table answers 42P01.
    expect(['3F000', '42P01']).toContain((outcome as unknown as { code?: string }).code);
    expect((outcome as unknown as Error).message).toMatch(/does not exist/);
    expect(fs.readFileSync(path.join(root, G, 'm', 'before.json'), 'utf-8')).toBe('{"b":1}');
    expect(fs.existsSync(path.join(root, G, 'm', 'late.json'))).toBe(false);
    const { rows } = await rig.admin.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'smdb\\_superseded\\_%'`);
    const late2 = await rig.admin.query(`SELECT count(*)::int AS n FROM "${rows[0].nspname}".guild_data WHERE filename = 'late.json'`);
    expect(late2.rows[0].n).toBe(0);
  });

  it("S7's second session reads the same hashes and holds no transaction at S9", async () => {
    await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{"a":1}');
    let inTx = -1;
    const service = realService(new FakeHost(), {
      fault: async p => {
        if (p !== 'S9') return;
        const { rows } = await rig.admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'smdb-migrate:job-share-0002' AND xact_start IS NOT NULL`);
        inTx = rows[0].n;
      },
    });
    await service.post({ jobId: 'job-share-0002', to: 'file' });
    await service.idle();
    expect(service.status().body.job?.state, why(service.status().body.job)).toBe('done');
    expect(inTx).toBe(1);
  });
});
