import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 L5 survivors, chunk 5: the job session's lock timeout and the watchdog's probe session.

const pgConfigs = vi.hoisted(() => [] as any[]);
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/pgClient')>();
  return {
    ...real,
    shortLivedClient: (config: any) => {
      pgConfigs.push(config);
      return { connect: async () => undefined, end: async () => undefined, query: async () => ({ rows: [] }), on: () => undefined };
    },
  };
});

import { MigrationService, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { loadCredentials } from '../../src/utils/envLoader';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

const G1 = '770000000000000001';

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
});

describe('the job session', () => {
  it('opens with the lock timeout the service was given', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    pgConfigs.length = 0;
    const service = new MigrationService(new FakeHost(), { nodeId: () => 'node-test', lockTimeoutMs: 1234, secondLookMs: 10, closeBoundMs: 50 });
    await service.post({ jobId: 'job-l5s5-lock-01', to: 'postgres' });
    await service.idle();
    expect(pgConfigs.length).toBeGreaterThan(0);
    expect(pgConfigs[0].options).toContain('lock_timeout=1234');
    expect(pgConfigs[0].options).toContain('statement_timeout=0');
  });

  it('a hung probe is bounded by the probe bound, and its socket is not destroyed by the answer bound', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    const db = new FakeDb();
    const destroyed: string[] = [];
    const never = new Promise<never>(() => undefined);
    const connect = async (_url: string, app: string, kind: 'job' | 'probe'): Promise<PgSession> => {
      const client = db.connect(app);
      const session = {
        query: (text: string, params: any[] = []) => {
          if (kind === 'job' && /SHOW server_encoding/.test(text)) return never;
          if (kind === 'probe' && /pg_stat_activity WHERE pid = \$1/.test(text)) return never;
          return client.query(text, params);
        },
        end: () => client.end(),
        connection: { stream: { destroy: () => { destroyed.push(kind); void client.end(); } } },
      };
      return session as unknown as PgSession;
    };
    const service = serviceFor(db, new FakeHost(), { connect, answerBoundMs: 30, probeBoundMs: 300, closeBoundMs: 50 });
    await service.post({ jobId: 'job-l5s5-probe-01', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toMatch(/SHOW got no answer from the database/);
    expect(destroyed).toEqual(['job']);
  });
});
