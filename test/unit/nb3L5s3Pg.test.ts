import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobSessionSettings, probeBackend, snapshotFromPgRows, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB3 L5 chunk 3: the backend a job session records, the watchdog's probe of it, the snapshot of Postgres rows, and
// what a job answers about the store id and the role's other sessions.

const G1 = '880000000000000001';

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
});

/** A session whose settings read answers this row; version 0 sends no SET. */
function settingsSession(row: Record<string, unknown>): PgSession {
  return { query: async () => ({ rows: [{ version: 0, ...row }] }), end: async () => undefined };
}

describe('jobSessionSettings records only a real backend', () => {
  it('a pid of 0 is no pid', async () => {
    expect((await jobSessionSettings(settingsSession({ pid: 0, started: '17' }))).pid).toBeNull();
  });

  it('a negative pid is no pid', async () => {
    expect((await jobSessionSettings(settingsSession({ pid: -5, started: '17' }))).pid).toBeNull();
  });

  it('a positive integer pid is kept', async () => {
    expect((await jobSessionSettings(settingsSession({ pid: 42, started: '17' }))).pid).toBe(42);
  });

  it('an empty start is no start', async () => {
    expect((await jobSessionSettings(settingsSession({ pid: 42, started: '' }))).started).toBeNull();
  });

  it('a start that is not text is no start', async () => {
    expect((await jobSessionSettings(settingsSession({ pid: 42, started: 5 }))).started).toBeNull();
  });
});

describe('probeBackend', () => {
  function probeSession(row: Record<string, unknown> | undefined) {
    const sent: string[] = [];
    let ended = 0;
    const session = {
      query: async (sql: string) => { sent.push(sql); return { rows: row ? [row] : [] }; },
      end: async () => { ended += 1; },
    } as PgSession;
    return { session, sent, ended: () => ended };
  }

  it('with no pid it opens no probe and says not busy', async () => {
    const open = vi.fn(async () => probeSession({ state: 'active', wait_event_type: 'Lock' }).session);
    expect(await probeBackend(open, { pid: null, started: '17' }, 1000)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('a backend that is idle is not busy, whatever it waits on', async () => {
    const p = probeSession({ state: 'idle', wait_event_type: 'Lock' });
    expect(await probeBackend(async () => p.session, { pid: 42, started: '17' }, 1000)).toBe(false);
  });

  it('an active backend that does not wait on the client is busy', async () => {
    const p = probeSession({ state: 'active', wait_event_type: 'Lock' });
    expect(await probeBackend(async () => p.session, { pid: 42, started: '17' }, 1000)).toBe(true);
  });

  it('a probe session that connects after the bound sends nothing and is ended', async () => {
    vi.useFakeTimers();
    const p = probeSession({ state: 'active', wait_event_type: 'Lock' });
    const open = () => new Promise<PgSession>(resolve => { setTimeout(() => resolve(p.session), 60); });
    const answer = probeBackend(open, { pid: 42, started: '17' }, 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await answer).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(p.sent).toEqual([]);
    expect(p.ended()).toBeGreaterThan(0);
  });
});

describe('snapshotFromPgRows', () => {
  it('rows of nothing make an empty snapshot', () => {
    const snap = snapshotFromPgRows([], [], []);
    expect(snap.guilds).toEqual([]);
    expect(snap.leftOut).toEqual([]);
  });

  it('refuses rows of an id that is not a guild id, naming it', () => {
    expect(() => snapshotFromPgRows([{ guild_id: 'abc', module: 'm', filename: 'a.json', doc: '{}' }], [], []))
      .toThrow('The database holds rows of "abc", which is not a guild id; nothing was written');
  });

  it('keeps two graveyard entries of one guild apart', () => {
    const grave = (retired: string, filename: string) => ({ guild_id: G1, module: 'm', filename, kind: 'doc', doc: '{}', retired_at: retired, reason: 'left' });
    const snap = snapshotFromPgRows([{ guild_id: G1, module: 'm', filename: 'live.json', doc: '{}' }], [], [grave('100', 'a.json'), grave('200', 'b.json')]);
    expect(snap.graves).toEqual([{ guildId: G1, retiredAt: 100, reason: 'left' }, { guildId: G1, retiredAt: 200, reason: 'left' }]);
    expect(snap.guilds).toEqual([G1]);
    expect(snap.items.map(i => [i.filename, i.grave, i.retiredAt])).toEqual([['live.json', false, undefined], ['a.json', true, 100], ['b.json', true, 200]]);
  });
});

async function runJob(db: FakeDb, jobId: string) {
  const service = serviceFor(db, new FakeHost());
  await service.post({ jobId, to: 'postgres' });
  await service.idle();
  return service.status().body.job;
}

describe('a move to Postgres', () => {
  it('a present smdb_data with an empty meta reads as a store with no id', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    const db = new FakeDb();
    db.schemas.set('smdb_data', emptyStore(null));
    const job = await runJob(db, 'job-s3-noid-01');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toMatch(/^The database already holds store with no id in schema smdb_data/);
  });

  it("the web UI's reader and the job's own sessions are not counted as other sessions", async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    const db = new FakeDb();
    db.sessions.push('smdb-webui-reader', 'smdb-migrate:job-s3-ours-01');
    const job = await runJob(db, 'job-s3-ours-01');
    expect(job, why(job)).toMatchObject({ state: 'done' });
  });

  it('a session with no application name is named unnamed', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    const db = new FakeDb();
    db.sessions.push(undefined as unknown as string);
    const job = await runJob(db, 'job-s3-null-01');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe("1 other session(s) or worker(s) are connected to this database (unnamed: 1); stop every bot and every other client of this database first");
  });
});
