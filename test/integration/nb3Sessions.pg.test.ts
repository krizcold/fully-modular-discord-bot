import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { otherSession, provisionedStore, realService, resetDatabase, startRig, stopRig, jsonBot, type PgRig } from '../helpers/pgMigrationRig';
import { openJobSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { FakeHost, JOURNAL, seedFile, snapshotRoot, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 decisions 4 and 5: other sessions of the bot's role, and the job's own sessions.

let rig: PgRig;
const G = '171717171717171717';

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

async function run(to: 'postgres' | 'file', fault?: (p: string) => void | Promise<void>) {
  const service = realService(new FakeHost(), { fault });
  const answer = await service.post({ jobId: 'job-sess-0001', to });
  await service.idle();
  return { answer, job: service.status().body.job };
}

describe('another session of the role', () => {
  it('refuses with the count at S2', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const other = await otherSession(rig);
    try {
      const { job } = await run('postgres');
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
      expect(job?.error, why(job)).toMatch(/1 other session/);
    } finally { await other.end(); }
  });

  it('refuses inside the read transaction (a session that connects between S2 and S4)', async () => {
    await provisionedStore(rig);
    let other: Client | null = null;
    const { job } = await run('file', async p => { if (p === 'S4') other = await otherSession(rig); });
    await (other as Client | null)?.end();
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job.error).toMatch(/^1 other session\(s\) of the bot's database role are connected \(unnamed: 1\)/);
  });

  it('refuses before the stage committing', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    let other: Client | null = null;
    const { job } = await run('postgres', async p => { if (p === 'before-commit') other = await otherSession(rig); });
    await (other as Client | null)?.end();
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(job.error).toMatch(/^1 other session\(s\) of the bot's database role are connected \(unnamed: 1\)/);
    const { rows } = await rig.admin.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'smdb_data'`);
    expect(rows[0].n).toBe(0);
  });

  it('the web UI reader\'s, another role\'s and the job\'s own sessions do not count; one named for another jobId does', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    await rig.admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'other_role') THEN CREATE ROLE other_role LOGIN PASSWORD 'pw'; END IF; END $$`);
    const url = new URL(rig.url);
    url.username = 'other_role';
    url.password = 'pw';
    const otherRole = new Client({ connectionString: url.toString() });
    await otherRole.connect();
    const reader = await otherSession(rig, 'smdb-webui-reader');
    try {
      const { job } = await run('postgres');
      expect(job?.state, why(job)).toBe('done');
    } finally {
      await otherRole.end();
      await reader.end();
    }
    wipeRoot();
    await resetDatabase(rig);
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const stale = await otherSession(rig, 'smdb-migrate:job-earlier-01');
    try {
      const { job } = await run('postgres');
      expect(job?.error, why(job)).toMatch(/job-earlier-01, which is not this bot's last one, holds a session on this database/);
    } finally { await stale.end(); }
  }, 90_000);

  it("each of the job's sessions has the keepalives and its application_name", async () => {
    for (const kind of ['job', 'probe'] as const) {
      const session = await openJobSession(rig.url, 'smdb-migrate:job-sess-0001', kind, 2000);
      try {
        for (const [k, v] of [['tcp_keepalives_idle', '30'], ['tcp_keepalives_interval', '10'], ['tcp_keepalives_count', '3']]) {
          expect((await session.query(`SHOW ${k}`)).rows[0][k]).toBe(v);
        }
        expect((await session.query('SHOW application_name')).rows[0].application_name).toBe('smdb-migrate:job-sess-0001');
        if (kind === 'job') {
          expect((await session.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0');
          expect((await session.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('0');
        }
      } finally { await session.end(); }
    }
  });
});

describe("S0's classification", () => {
  it('refuses with "can\'t confirm; migration <id>\'s database session is still open" and writes nothing; its own read session is not counted', async () => {
    const storeId = await provisionedStore(rig);
    const address = { host: new URL(rig.url).hostname.toLowerCase(), port: Number(new URL(rig.url).port), database: new URL(rig.url).pathname.slice(1) };
    writeJson(JOURNAL, { jobId: 'job-sess-0002', to: 'file', stage: 'retire-source', sourceStoreId: storeId, source: address, startedAt: 1 });
    const open = await otherSession(rig, 'smdb-migrate:job-sess-0002');
    const before = snapshotRoot();
    try {
      const service = realService();
      const answer = await service.post({ jobId: 'job-sess-0003', to: 'file' });
      expect(answer.body).toMatchObject({ success: false, error: "can't confirm; migration job-sess-0002's database session is still open; the database ends it once it notices the connection is gone; run the migration again once it no longer shows" });
      expect(snapshotRoot()).toEqual(before);
    } finally { await open.end(); }
    const service = realService();
    const again = await service.post({ jobId: 'job-sess-0002', to: 'file' });
    expect(again.body, why(again.body)).toMatchObject({ success: true, jobId: 'job-sess-0002', state: 'started' });
    await service.idle();
  });
});
