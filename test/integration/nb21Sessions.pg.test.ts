import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, type ClientConfig } from 'pg';
import { openJobSession, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { insertDoc, listStore, otherSession, provisionedStore, realService, resetDatabase, schemas, sessionsGone, startRig, stopRig, jsonBot, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, JOURNAL, MARKER, STORES, readJson, root, seedFile, snapshotRoot, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB21 test 8.4: the session check counts every client of the database of any role, and only of this database.

let rig: PgRig;
let database: string;
let superuser: string;
const G = '212121212121212121';
const STOP = 'stop every bot and every other client of this database first';
const ONE = (label: string) => `1 other session(s) or worker(s) are connected to this database (${label}: 1); ${STOP}`;

function urlAs(role: string, db = database): string {
  const url = new URL(rig.url);
  url.username = role;
  url.password = 'pw';
  url.pathname = `/${db}`;
  return url.toString();
}

async function sessionAs(role: string, app: string): Promise<Client> {
  const c = new Client({ connectionString: urlAs(role), application_name: app });
  await c.connect();
  return c;
}

/** Ends the rig's admin pool's idle clients (superuser, named smdb-webui-reader), which count for a job of another role. */
async function endAdminClients(held?: Client): Promise<void> {
  const sweep = new Client({ connectionString: rig.url, application_name: 'nb21-sweep' });
  await sweep.connect();
  try {
    await sweep.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = session_user AND application_name = 'smdb-webui-reader' AND pid <> pg_backend_pid()`);
  } finally { await sweep.end(); }
  const watch = held ?? await sessionAs('nb21_bot', 'smdb-webui-reader');
  try {
    const until = Date.now() + 10_000;
    for (;;) {
      const { rows } = await watch.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = $1`, [superuser]);
      if (rows[0].n === 0) return;
      if (Date.now() > until) throw new Error(`${rows[0].n} session(s) of ${superuser} still open`);
      await new Promise(r => setTimeout(r, 100));
    }
  } finally { if (!held) await watch.end(); }
}

/** A snapshot of the data root without the journal, which a failed job rewrites, and the store list, which S2 writes. */
function withoutJobFiles(snapshot: Record<string, string>): Record<string, string> {
  const { '.migration.json': _journal, '.stores.json': _stores, ...rest } = snapshot;
  return rest;
}

async function run(jobId: string, to: 'postgres' | 'file', extra: Parameters<typeof realService>[1] = {}) {
  const service = realService(new FakeHost(), extra);
  const answer = await service.post({ jobId, to });
  await service.idle();
  return { answer, job: service.status().body.job };
}

beforeAll(async () => {
  rig = await startRig();
  const url = new URL(rig.url);
  database = url.pathname.slice(1);
  superuser = decodeURIComponent(url.username);
  for (const role of ['nb21_bot', 'nb21_other']) await rig.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER`);
  await rig.admin.query('CREATE ROLE nb21_owner NOLOGIN');
  await rig.admin.query(`GRANT CREATE ON DATABASE "${database}" TO nb21_bot, nb21_owner`);
  await rig.admin.query('CREATE DATABASE nb21_elsewhere');
}, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await sessionsGone(rig);
});

describe('a session of another role', () => {
  it('refuses at S2, named with its role', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const outside = await sessionAs('nb21_other', 'outside');
    try {
      const { job } = await run('job-nb21-s2-0001', 'postgres');
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: ONE('outside as nb21_other') });
    } finally { await outside.end(); }
    expect(await schemas(rig)).toEqual([]);
  });

  it('opened at S4 of a move to JSON, refuses at reading', async () => {
    const storeId = await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{"a":1}');
    seedFile(`${G}/m/a.json`, '{"local":1}');
    const before = snapshotRoot();
    let outside: Client | null = null;
    try {
      const { job } = await run('job-nb21-s4-0001', 'file', { fault: async p => { if (p === 'S4') outside = await sessionAs('nb21_other', 'outside'); } });
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading', error: ONE('outside as nb21_other') });
    } finally { await (outside as Client | null)?.end(); }
    expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
    expect(withoutJobFiles(snapshotRoot())).toEqual(withoutJobFiles(before));
    expect(readJson(STORES).storeIds).toEqual([storeId]);
    expect(readJson(MARKER).live).toBe('postgres');
  });

  it('opened at S5 of a move to Postgres over a served store, refuses at copying with nothing renamed', async () => {
    const storeId = await provisionedStore(rig);
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    listStore(storeId);
    seedFile(`${G}/m/a.json`, '{"a":1}');
    let outside: Client | null = null;
    try {
      const { job } = await run('job-nb21-s5-0001', 'postgres', { fault: async p => { if (p === 'S5') outside = await sessionAs('nb21_other', 'outside'); } });
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying', error: ONE('outside as nb21_other') });
    } finally { await (outside as Client | null)?.end(); }
    expect(await schemas(rig)).toEqual(['smdb_data']);
    const { rows } = await rig.admin.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`);
    expect(JSON.parse(rows[0].value)).toBe(storeId);
    expect(readJson(MARKER).live).toBe('file');
  });

  it('opened before the commit of a move to Postgres, refuses at rereading with no smdb_data committed', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    let outside: Client | null = null;
    try {
      const { job } = await run('job-nb21-bc-0001', 'postgres', { fault: async p => { if (p === 'before-commit') outside = await sessionAs('nb21_other', 'outside'); } });
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading', error: ONE('outside as nb21_other') });
    } finally { await (outside as Client | null)?.end(); }
    expect(await schemas(rig)).toEqual([]);
    expect(readJson(MARKER).live).toBe('file');
  });

  it('opened at S8 of a move to JSON, refuses at placing with nothing placed', async () => {
    const storeId = await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{"a":1}');
    seedFile(`${G}/m/a.json`, '{"local":1}');
    const before = snapshotRoot();
    let outside: Client | null = null;
    let staged = 0;
    try {
      const { job } = await run('job-nb21-s8-0001', 'file', { fault: async p => {
        if (p !== 'S8') return;
        staged = fs.readdirSync(root).filter(n => n.startsWith('.migrate-') && fs.existsSync(path.join(root, n, G, 'm', 'a.json'))).length;
        outside = await sessionAs('nb21_other', 'outside');
      } });
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'placing', error: ONE('outside as nb21_other') });
    } finally { await (outside as Client | null)?.end(); }
    expect(staged).toBe(1);
    expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
    expect(withoutJobFiles(snapshotRoot())).toEqual(withoutJobFiles(before));
    expect(readJson(STORES).storeIds).toEqual([storeId]);
    expect(fs.readFileSync(path.join(root, G, 'm', 'a.json'), 'utf8')).toBe('{"local":1}');
    expect(readJson(MARKER).live).toBe('postgres');
    expect(await schemas(rig)).toEqual(['smdb_data']);
  });

  it("named as the web UI reader refuses; named as the job's own session refuses with the other-sessions text", async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const reader = await sessionAs('nb21_other', 'smdb-webui-reader');
    try {
      const { job } = await run('job-nb21-name-0001', 'postgres');
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: ONE('smdb-webui-reader as nb21_other') });
    } finally { await reader.end(); }
    await sessionsGone(rig);
    wipeRoot();
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const named = await sessionAs('nb21_other', 'smdb-migrate:job-nb21-name-0002');
    try {
      const { job } = await run('job-nb21-name-0002', 'postgres');
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: ONE('smdb-migrate:job-nb21-name-0002 as nb21_other') });
      expect(job.error).not.toMatch(/Migration /);
    } finally { await named.end(); }
  }, 90_000);
});

describe("sessions of the bot's own role that are not its client backends, and other databases", () => {
  it("a logical replication session of the job's role refuses at S2, named as a walsender", async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const repl = new Client({ connectionString: rig.url, application_name: 'nb21-repl', replication: 'database' } as ClientConfig);
    await repl.connect();
    try {
      const { job } = await run('job-nb21-repl-0001', 'postgres');
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: ONE('nb21-repl (walsender)') });
    } finally { await repl.end(); }
  });

  it("a session of the job's role on another database of the server does not refuse", async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const url = new URL(rig.url);
    url.pathname = '/nb21_elsewhere';
    const elsewhere = new Client({ connectionString: url.toString(), application_name: 'elsewhere' });
    await elsewhere.connect();
    try {
      const { job } = await run('job-nb21-else-0001', 'postgres');
      expect(job?.state, why(job)).toBe('done');
    } finally { await elsewhere.end(); }
  });
});

describe('run as a role that cannot see the kinds of other roles', () => {
  it("a superuser session that stays refuses, named with its role; one that logs in and out within the first look does not", async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    useDatabaseUrl(urlAs('nb21_bot'));
    await endAdminClients();
    let reads = 0;
    const readStages: string[] = [];
    const { job: blipped } = await run('job-nb21-hid-0001', 'postgres', {
      secondLookMs: 3000,
      connect: async (url, app, kind) => {
        const session = await openJobSession(url, app, kind, 2000);
        const blipping = {
          query: async (text: string, params?: unknown[]) => {
            if (!/FROM pg_stat_activity WHERE datname = current_database\(\) AND usesysid IS NOT NULL/.test(text)) return session.query(text, params);
            readStages.push(readJson(JOURNAL).stage);
            if (reads++ > 0) return session.query(text, params);
            const probe = await otherSession(rig, 'pg-probe');
            try {
              return await session.query(text, params);
            } finally {
              await probe.end();
            }
          },
          end: () => session.end(),
        };
        Object.defineProperty(blipping, 'connection', { get: () => (session as { connection?: unknown }).connection });
        return blipping as unknown as PgSession;
      },
    });
    expect(blipped, why(blipped)).toMatchObject({ state: 'done' });
    expect(readStages.filter(st => st === 'checking').length).toBeGreaterThanOrEqual(2);

    wipeRoot();
    await resetDatabase(rig);
    await sessionsGone(rig);
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    await endAdminClients();
    const stays = await otherSession(rig, 'stays');
    try {
      const { job } = await run('job-nb21-hid-0002', 'postgres', { secondLookMs: 300 });
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: ONE(`stays as ${superuser}`) });
    } finally { await stays.end(); }
  }, 90_000);

  it('a default role that hides its own sessions refuses, naming its own reader; pg_read_all_stats on the default role lets it pass (C19)', async () => {
    await rig.admin.query('GRANT nb21_owner TO nb21_bot');
    await rig.admin.query('ALTER ROLE nb21_bot SET role = nb21_owner');
    let reader: Client | null = null;
    try {
      jsonBot();
      seedFile(`${G}/m/a.json`, '{}');
      useDatabaseUrl(urlAs('nb21_bot'));
      reader = await sessionAs('nb21_bot', 'smdb-webui-reader');
      await endAdminClients(reader);
      const { job } = await run('job-nb21-c19-0001', 'postgres', { secondLookMs: 300 });
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: ONE('smdb-webui-reader') });
      expect(await schemas(rig)).toEqual([]);

      await rig.admin.query('GRANT pg_read_all_stats TO nb21_owner');
      wipeRoot();
      jsonBot();
      seedFile(`${G}/m/a.json`, '{}');
      await endAdminClients(reader);
      const { job: again } = await run('job-nb21-c19-0002', 'postgres', { secondLookMs: 300 });
      expect(again?.state, why(again)).toBe('done');
    } finally {
      await reader?.end();
      await rig.admin.query('ALTER ROLE nb21_bot RESET role');
      await rig.admin.query('REVOKE pg_read_all_stats FROM nb21_owner');
      await rig.admin.query('REVOKE nb21_owner FROM nb21_bot');
    }
  }, 90_000);
});
