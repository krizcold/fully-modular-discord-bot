import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { closeSession, jobSessionSettings, openJobSession, probeBackend, watchSession, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import {
  insertDoc, otherSession, provisionedStore, realService, resetDatabase, sessionsGone, startRig, stopRig, jsonBot, type PgRig,
} from '../helpers/pgMigrationRig';
import { FakeHost, JOURNAL, MARKER, readJson, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB3 code review rounds 3 and 4 against a real Postgres: the session settings by server version (R3-5, R4-T1), the
// stream read-back guild by guild, a busy statement kept over the probe (R3-4) and the probe's pid and start (R4-RUN-4).
// tcp_user_timeout's SHOW answers the socket's value in milliseconds with no unit.

let rig: PgRig;
const G1 = '292929292929292901';
const G2 = '292929292929292902';
const APP = 'smdb-migrate:job-r3pg-0001';

beforeAll(async () => {
  rig = await startRig();
}, 180_000);
afterAll(async () => {
  await stopRig(rig);
});
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  await sessionsGone(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** The session with the server version it answers replaced, for the version check on a server newer than the case. */
function reportingVersion(session: PgSession, version: number): PgSession {
  return {
    query: async (text: string, params?: unknown[]) => {
      const res = await session.query(text, params);
      return /current_setting\('server_version_num'\)/.test(text) ? { ...res, rows: [{ ...res.rows[0], version }] } : res;
    },
    end: () => session.end(),
  };
}

const show = async (session: PgSession, name: string) => String((await session.query(`SHOW ${name}`)).rows[0][name]);

describe('NB3-R3-5: the settings of a job session by server version', () => {
  it('this server (16) gets tcp_user_timeout 60 s and client_connection_check_interval 10 s, and answers its version, pid and start', async () => {
    const session = await openJobSession(rig.url, APP, 'job', 2000);
    try {
      const got = await jobSessionSettings(session);
      expect(got.version).toBeGreaterThanOrEqual(140000);
      expect(got.pid).toBe(Number((await session.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
      expect(got.started).toMatch(/^\d+$/);
      expect(await show(session, 'tcp_user_timeout')).toBe('60000');
      expect(await show(session, 'client_connection_check_interval')).toBe('10s');
    } finally { await session.end(); }
  });

  it('a version read of 13 sets tcp_user_timeout only, and 11 neither', async () => {
    for (const [version, tcp, check] of [[130000, '60000', '0'], [110000, '0', '0']] as const) {
      const session = await openJobSession(rig.url, APP, 'job', 2000);
      try {
        await jobSessionSettings(reportingVersion(session, version));
        expect(await show(session, 'tcp_user_timeout')).toBe(tcp);
        expect(await show(session, 'client_connection_check_interval')).toBe(check);
      } finally { await session.end(); }
    }
  });

  it("to JSON: both of the job's sessions hold the settings, and the job is done", async () => {
    await provisionedStore(rig);
    await insertDoc(rig, G1, 'm', 'a.json', '{"a":1}');
    const held: Array<{ kind: string; tcp: string; check: string }> = [];
    const service = realService(new FakeHost(), {
      connect: async (url, app, kind) => {
        const session = await openJobSession(url, app, kind, 2000);
        const checked = {
          query: async (text: string, params?: unknown[]) => {
            const res = await session.query(text, params);
            if (/^SET client_connection_check_interval/.test(text)) {
              held.push({ kind, tcp: await show(session, 'tcp_user_timeout'), check: await show(session, 'client_connection_check_interval') });
            }
            return res;
          },
          end: () => session.end(),
        };
        Object.defineProperty(checked, 'connection', { get: () => (session as { connection?: unknown }).connection });
        return checked;
      },
    });
    await service.post({ jobId: 'job-r3pg-0002', to: 'file' });
    await service.idle();
    expect(service.status().body.job, why(service.status().body.job)).toMatchObject({ state: 'done' });
    expect(held).toEqual([{ kind: 'job', tcp: '60000', check: '10s' }, { kind: 'job', tcp: '60000', check: '10s' }]);
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });
});

describe('NB3-R3-4: the read-back and the probe', () => {
  it("S6 reads the destination's streams back guild by guild and the job is done", async () => {
    jsonBot();
    seedFile(`${G1}/m/s.jsonl`, '{"a":1}\n');
    seedFile(`${G2}/m/t.jsonl`, '{"b":2}\n{"c":3}\n');
    const reads: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const service = realService(new FakeHost(), {
      connect: async (url, app, kind) => {
        const session = await openJobSession(url, app, kind, 2000);
        const recorded = {
          query: (text: string, params?: unknown[]) => {
            if (/string_agg\(chunk/.test(text)) reads.push({ sql: text, params });
            return session.query(text, params);
          },
          end: () => session.end(),
        };
        Object.defineProperty(recorded, 'connection', { get: () => (session as { connection?: unknown }).connection });
        return recorded;
      },
    });
    await service.post({ jobId: 'job-r3pg-0003', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job, why(service.status().body.job)).toMatchObject({ state: 'done' });
    expect(reads.map(r => r.params)).toEqual([[G1], [G2]]);
    for (const r of reads) expect(r.sql).toMatch(/WHERE guild_id = \$1/);
    const { rows } = await rig.admin.query('SELECT guild_id, count(*)::int AS n FROM smdb_data.guild_append GROUP BY 1 ORDER BY 1');
    expect(rows).toEqual([{ guild_id: G1, n: 1 }, { guild_id: G2, n: 1 }]);
  });

  it('a statement the server works on past the bound is kept when the probe finds its backend active', async () => {
    const session = await openJobSession(rig.url, APP, 'job', 2000);
    const bare = await openJobSession(rig.url, APP, 'job', 2000);
    try {
      const { pid, started } = await jobSessionSettings(session);
      let asked = 0;
      const watched = watchSession(session, 500, async () => {
        asked += 1;
        return probeBackend(() => openJobSession(rig.url, APP, 'probe'), { pid, started }, 2000);
      });
      const res = await watched.query('SELECT pg_sleep(2) AS slept');
      expect(res.rows).toHaveLength(1);
      expect(asked).toBeGreaterThanOrEqual(1);
      await expect(watchSession(bare, 500).query('SELECT pg_sleep(2)')).rejects.toThrow('The SELECT got no answer from the database within 0.5 s');
    } finally {
      await closeSession(session, 1000);
      await closeSession(bare, 1000);
    }
  });

  it('the probe finds a running backend by its pid and start; the same pid with another start reads as gone', async () => {
    const session = await openJobSession(rig.url, APP, 'job', 2000);
    try {
      const { pid, started } = await jobSessionSettings(session);
      const running = session.query('SELECT pg_sleep(1.5)');
      await new Promise(resolve => { setTimeout(resolve, 300); });
      const open = () => openJobSession(rig.url, APP, 'probe');
      expect(await probeBackend(open, { pid, started }, 2000)).toBe(true);
      expect(await probeBackend(open, { pid, started: String(Number(started) - 1) }, 2000)).toBe(false);
      await running;
    } finally { await closeSession(session, 1000); }
  });

  it('to JSON: a lock wait past the bound is kept, and the lock timeout ends it, not the watchdog', async () => {
    await provisionedStore(rig);
    await insertDoc(rig, G1, 'm', 'a.json', '{"a":1}');
    let holder: PoolClient | null = null;
    const host = new FakeHost();
    const service = realService(host, {
      answerBoundMs: 500,
      lockTimeoutMs: 3000,
      fault: async p => {
        if (p !== 'S4') return;
        holder = await rig.admin.connect();
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE smdb_data.guild_data IN ACCESS EXCLUSIVE MODE');
      },
    });
    try {
      await service.post({ jobId: 'job-r3pg-0004', to: 'file' });
      await service.idle();
    } finally {
      const h = holder as PoolClient | null;
      if (h) {
        await h.query('ROLLBACK').catch(() => undefined);
        h.release();
      }
    }
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job.error).toMatch(/lock timeout/);
    expect(job.error).not.toMatch(/got no answer/);
    expect(host.lock).toBeNull();
    expect(readJson(MARKER).live).toBe('postgres');
  });
});

describe('the second look at the sessions of the role', () => {
  const OTHER = (named: string) => `1 other session(s) or worker(s) are connected to this database (${named}: 1); stop every bot and every other client of this database first`;

  it('a client that logs in and out within the first look does not refuse the job; one that stays does', async () => {
    jsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    let reads = 0;
    const readStages: string[] = [];
    const service = realService(new FakeHost(), {
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
        return blipping;
      },
    });
    await service.post({ jobId: 'job-r6pg-0001', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job, why(service.status().body.job)).toMatchObject({ state: 'done' });
    expect(readStages.filter(st => st === 'checking').length).toBeGreaterThanOrEqual(2);
    await sessionsGone(rig);

    await resetDatabase(rig);
    jsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    const bot = await otherSession(rig, 'other-bot');
    try {
      const host = new FakeHost();
      const again = realService(host, { secondLookMs: 300 });
      await again.post({ jobId: 'job-r6pg-0002', to: 'postgres' });
      await again.idle();
      expect(again.status().body.job, why(again.status().body.job)).toMatchObject({ state: 'failed', stage: 'checking', error: OTHER('other-bot') });
      expect(host.lock).toBeNull();
    } finally {
      await bot.end();
    }
    await sessionsGone(rig);
  }, 90_000);
});
