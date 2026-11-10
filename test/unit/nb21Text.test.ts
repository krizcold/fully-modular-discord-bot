import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { otherSessionsRefusal } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

const G = '771000000000000001';

// NB21 section 3: the refusal names every counted backend by its label, of either role, and keeps the migration
// session texts for the job sessions of the bot's own role only.

const STOP = 'stop every bot and every other client of this database first';
const ONCE_GONE = 'the database ends it once it notices the connection is gone; run the migration again once it no longer shows';
const own = (app: string, kind: string | null = 'client backend') => ({ app, role: 'nb21_bot', own: true, kind });
const other = (app: string, role: string, kind: string | null = 'client backend') => ({ app, role, own: false, kind });

// The manager's transientRefusal model (docker-discord-bot-manager src/instance/migrate.ts SESSION_LAST, SESSION_OTHER).
const SESSION_LAST = /^Migration (.+?)'s database session is still open; the database ends it once it notices the connection is gone; run the migration again once it no longer shows$/;
const SESSION_OTHER = /^Migration (.+?), which is not this bot's last one, holds a session on this database; run this migration once it no longer shows$/;
const sessionPartsOnly = (text: string) => text.split('. ').every(p => SESSION_LAST.test(p) || SESSION_OTHER.test(p));

describe('otherSessionsRefusal', () => {
  it('gives nothing when no row counts', () => {
    expect(otherSessionsRefusal([], null)).toBeNull();
  });

  it('names the groups of both roles, sorted by label, an empty name as unnamed', () => {
    const text = otherSessionsRefusal([other('pg_dump', 'dbm_admin'), own('other-bot'), own(''), own('other-bot')], null);
    expect(text).toBe(`4 other session(s) or worker(s) are connected to this database (other-bot: 2, pg_dump as dbm_admin: 1, unnamed: 1); ${STOP}`);
  });

  it('the example of the sheet', () => {
    expect(otherSessionsRefusal([own('other-bot'), other('pg_dump', 'dbm_admin')], null))
      .toBe(`2 other session(s) or worker(s) are connected to this database (other-bot: 1, pg_dump as dbm_admin: 1); ${STOP}`);
  });

  it('sorts by code unit, so an upper-case label comes before a lower-case one', () => {
    expect(otherSessionsRefusal([other('pg_dump', 'dbm_admin'), other('Zabbix', 'monitor')], null))
      .toBe(`2 other session(s) or worker(s) are connected to this database (Zabbix as monitor: 1, pg_dump as dbm_admin: 1); ${STOP}`);
  });

  it('a lone psql of the manager names only it', () => {
    expect(otherSessionsRefusal([other('psql', 'dbm_admin')], null))
      .toBe(`1 other session(s) or worker(s) are connected to this database (psql as dbm_admin: 1); ${STOP}`);
  });

  it('a session of a dropped role names its oid', () => {
    expect(otherSessionsRefusal([other('psql', 'role 16384')], null))
      .toBe(`1 other session(s) or worker(s) are connected to this database (psql as role 16384: 1); ${STOP}`);
  });

  it('joins the job parts after it, as before', () => {
    expect(otherSessionsRefusal([own('other-bot'), own('smdb-migrate:job-nb21-old')], 'job-nb21-old'))
      .toBe(`1 other session(s) or worker(s) are connected to this database (other-bot: 1); ${STOP}. Migration job-nb21-old's database session is still open; ${ONCE_GONE}`);
  });

  it("an own job session of another id gives the session text", () => {
    const text = otherSessionsRefusal([own('smdb-migrate:job-nb21-other')], 'job-nb21-last');
    expect(text).toBe("Migration job-nb21-other, which is not this bot's last one, holds a session on this database; run this migration once it no longer shows");
    expect(sessionPartsOnly(text!)).toBe(true);
  });

  it("another role's row named as a job session gives the other-sessions text and no session text", () => {
    const text = otherSessionsRefusal([other('smdb-migrate:job-nb21-this', 'nb21_other')], 'job-nb21-this');
    expect(text).toBe(`1 other session(s) or worker(s) are connected to this database (smdb-migrate:job-nb21-this as nb21_other: 1); ${STOP}`);
    expect(sessionPartsOnly(text!)).toBe(false);
  });

  it('an own walsender named as the last job gives the other-sessions text with its kind and no session text', () => {
    const text = otherSessionsRefusal([own('smdb-migrate:job-nb21-last', 'walsender')], 'job-nb21-last');
    expect(text).toBe(`1 other session(s) or worker(s) are connected to this database (smdb-migrate:job-nb21-last (walsender): 1); ${STOP}`);
    expect(sessionPartsOnly(text!)).toBe(false);
  });

  it("another role's leader and two workers with hidden kinds count as three under one name", () => {
    expect(otherSessionsRefusal([other('psql', 'alice', null), other('psql', 'alice', null), other('psql', 'alice', null)], null))
      .toBe(`3 other session(s) or worker(s) are connected to this database (psql as alice: 3); ${STOP}`);
  });

  it('an apply worker shows its kind, and its role when it is another', () => {
    expect(otherSessionsRefusal([own('', 'logical replication worker'), other('', 'alice', 'logical replication worker')], null))
      .toBe(`2 other session(s) or worker(s) are connected to this database (unnamed (logical replication worker): 1, unnamed (logical replication worker) as alice: 1); ${STOP}`);
  });

  it('a hidden kind keeps the label without a kind', () => {
    expect(otherSessionsRefusal([own('smdb-webui-reader', null)], null))
      .toBe(`1 other session(s) or worker(s) are connected to this database (smdb-webui-reader: 1); ${STOP}`);
  });

  it('an own client backend and an own walsender of one name are two groups', () => {
    expect(otherSessionsRefusal([own('other-bot'), own('other-bot', 'walsender')], null))
      .toBe(`2 other session(s) or worker(s) are connected to this database (other-bot: 1, other-bot (walsender): 1); ${STOP}`);
  });
});

describe('the check names the rows it reads', () => {
  beforeEach(() => {
    wipeRoot();
    useDatabaseUrl(PG_URL);
    delete process.env.BOT_MANAGER_UPDATE_TOKEN;
    delete process.env.DATA_BACKEND;
    loadCredentials();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BOT_MANAGER_UPDATE_TOKEN;
    delete process.env.DATA_BACKEND;
    wipeRoot();
  });

  it("another role's session refuses at checking, named with its role", async () => {
    freshJsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const db = new FakeDb();
    db.sessions.push('psql', 'smdb-webui-reader');
    db.sessionMeta.set('psql', { role: 'dbm_admin', own: false });
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-nb21-text-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe(`1 other session(s) or worker(s) are connected to this database (psql as dbm_admin: 1); ${STOP}`);
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});
