import fs from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { openJobSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { jsonBot, listStore, otherSession, provisionedStore, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, JOURNAL, STORES, readJson, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB3 decision 11: Postgres as the destination.

let rig: PgRig;
const G = '272727272727272727';

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

async function run(fault?: (p: string) => void | Promise<void>, jobId = 'job-dest-0001') {
  const service = realService(new FakeHost(), { fault });
  await service.post({ jobId, to: 'postgres' });
  await service.idle();
  return service.status().body.job;
}
const seed = () => { jsonBot(); seedFile(`${G}/m/a.json`, '{"a":1}'); };

/** NB4 decision 25: an unreleased claim of a process whose machine heartbeat within its takeover delay. */
async function liveClaim(r: PgRig): Promise<void> {
  await r.admin.query(`INSERT INTO smdb_data.shard_nodes (node_id, node_name, process_id, capacity, takeover_seconds, fit, restartable, returns, started_at, seen_at)
    VALUES ('other-node', 'Other', 'p-other', 1, 30, true, true, true, now(), now())`);
  await r.admin.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
    VALUES (1, 0, 5, 'p-other', 'other-node', 'Other', 'other-node', 30000, 30000)`);
}

describe('the destination', () => {
  it('a database with no schema is provisioned; the journal holds its normalized address from S5', async () => {
    seed();
    let atS5: any = null;
    const job = await run(p => { if (p === 'S6') atS5 = readJson(JOURNAL).destination; });
    expect(job?.state, why(job)).toBe('done');
    const u = new URL(rig.url);
    expect(atS5).toEqual({ host: u.hostname.toLowerCase(), port: Number(u.port), database: u.pathname.slice(1) });
    expect(await schemas(rig)).toEqual(['smdb_data']);
  });

  it('a schema created between S2 and S5 fails the job and is left as it was', async () => {
    seed();
    const job = await run(async p => { if (p === 'S3') await rig.admin.query('CREATE SCHEMA smdb_data'); });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying' });
    expect(await schemas(rig)).toEqual(['smdb_data']);
    const tables = await rig.admin.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'smdb_data'`);
    expect(tables.rows[0].n).toBe(0);
  });

  it('a bootstrap holding the advisory lock makes the job wait, and past lock_timeout fail', async () => {
    seed();
    const holder = new Client({ connectionString: rig.url, application_name: 'smdb-webui-reader' });
    await holder.connect();
    await holder.query(`SELECT pg_advisory_lock(hashtext('smdb_data_bootstrap'))`);
    const t0 = Date.now();
    const job = await run();
    await holder.end();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying' });
  });

  it('a schema whose store id is on the list is renamed aside and kept', async () => {
    const old = await provisionedStore(rig);
    seed();
    listStore(old);
    const job = await run();
    expect(job?.state, why(job)).toBe('done');
    const names = await schemas(rig);
    expect(names).toContain('smdb_data');
    const sup = names.find(n => n.startsWith('smdb_superseded_'))!;
    expect(JSON.parse((await rig.admin.query(`SELECT value FROM "${sup}".meta WHERE key = 'store_id'`)).rows[0].value)).toBe(old);
    expect(readJson(STORES).storeIds).toEqual([old, job.storeId]);
  });

  it('with another session, a live shard claim of another machine or a store id changed between S2 and S5 it is not renamed', async () => {
    for (const how of ['session', 'node', 'id'] as const) {
      wipeRoot();
      await resetDatabase(rig);
      const old = await provisionedStore(rig);
      seed();
      listStore(old);
      let other: Client | null = null;
      const job = await run(async p => {
        if (p !== 'S4') return;
        if (how === 'session') other = await otherSession(rig);
        if (how === 'node') await liveClaim(rig);
        if (how === 'id') await rig.admin.query(`UPDATE smdb_data.meta SET value = '"changed"' WHERE key = 'store_id'`);
      }, `job-dest-${how}`);
      await (other as Client | null)?.end();
      expect(job, `${how} ${why(job)}`).toMatchObject({ state: 'failed', stage: 'copying' });
      const said = { session: /1 other session\(s\) .*\(unnamed: 1\)/, node: /has shard claims of bot processes seen in the last 30 s: shard 0 held by Other \(seen \d+ s ago\); stop the bot on those machines \(a clean stop releases its claims\), then retry; it was not renamed/, id: /changed from .* to changed since the first check; it was not renamed/ }[how];
      expect(job.error, how).toMatch(said);
      expect(await schemas(rig), how).toEqual(['smdb_data']);
      const held = JSON.parse((await rig.admin.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`)).rows[0].value);
      expect(held, how).toBe(how === 'id' ? 'changed' : old);
    }
  }, 90_000);

  it('any other schema refuses with its store id; an empty one says it holds no guild rows', async () => {
    const foreign = await provisionedStore(rig);
    seed();
    const job = await run();
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job?.error, why(job)).toContain(foreign);
    expect(job?.error, why(job)).toMatch(/holds no guild rows/);
    await rig.admin.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ('1', 'm', 'x.json', '{}')`);
    const second = await run(undefined, 'job-dest-0002');
    expect(second?.error, why(second)).toContain(foreign);
    expect(second?.error, why(second)).not.toMatch(/holds no guild rows/);
  }, 90_000);

  it('at S8: the list gets the new id, then the journal, then the recheck, then committing, then COMMIT; a session there rolls back', async () => {
    seed();
    let other: Client | null = null;
    const job = await run(async p => { if (p === 'before-commit') other = await otherSession(rig); });
    await (other as Client | null)?.end();
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    const listed = readJson(STORES).storeIds;
    expect(listed).toHaveLength(1);
    expect(readJson(JOURNAL).storeId).toBe(listed[0]);
    expect(await schemas(rig)).toEqual([]);
  });

  it('a refused login answers "The database refused the bot\'s login"', async () => {
    seed();
    await rig.admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'blocked') THEN CREATE ROLE blocked NOLOGIN PASSWORD 'pw'; END IF; END $$`);
    const u = new URL(rig.url);
    u.username = 'blocked';
    u.password = 'pw';
    useDatabaseUrl(u.toString());
    const job = await run();
    expect(job?.error, why(job)).toBe("The database refused the bot's login");
    expect(fs.existsSync(STORES)).toBe(false);
  });

  it('lock_timeout ends a wait on a held lock; a 40 s statement is not cut', async () => {
    await rig.admin.query('CREATE TABLE IF NOT EXISTS public.nb3_locked (x int)');
    const holder = new Client({ connectionString: rig.url });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE public.nb3_locked IN ACCESS EXCLUSIVE MODE');
    const session = await openJobSession(rig.url, 'smdb-migrate:job-dest-time', 'job', 1000);
    try {
      await expect(session.query('SELECT * FROM public.nb3_locked')).rejects.toMatchObject({ code: '55P03' });
      await holder.query('ROLLBACK');
      const t0 = Date.now();
      await session.query('SELECT pg_sleep(40)');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(39_000);
    } finally {
      await session.end();
      await holder.end();
    }
  }, 90_000);
});
