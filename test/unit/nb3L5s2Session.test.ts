import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// NB3 mutation gate, chunk 2: the startup settings of a job session and of a probe, a connect that fails, and the
// drain's bound on the web UI's queued guild writes.

const rig = vi.hoisted(() => ({
  configs: [] as any[],
  connectError: null as Error | null,
  connects: 0,
  ends: 0,
  flushes: 0,
  queued: [] as string[],
}));

vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/pgClient')>();
  return {
    ...real,
    shortLivedClient: (config: any) => {
      rig.configs.push(config);
      return {
        connect: async () => {
          rig.connects += 1;
          if (rig.connectError) throw rig.connectError;
        },
        end: async () => { rig.ends += 1; },
        query: async () => ({ rows: [] }),
        on: () => undefined,
      };
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    flushAll: async () => { rig.flushes += 1; },
    queuedFilePaths: () => rig.queued,
  };
});

import { drainGuildWrites, openJobSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { root } from '../helpers/migrationRig';

const KEEPALIVES = '-c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3';
const URL = 'postgres://bot:pw@db.example:5432/smdb';

afterEach(() => {
  vi.restoreAllMocks();
  rig.configs.length = 0;
  rig.connectError = null;
  rig.connects = 0;
  rig.ends = 0;
  rig.flushes = 0;
  rig.queued = [];
});

describe('NB3 L5 s2: the settings a session starts with', () => {
  it('a job session has no statement or idle timeout and the lock timeout it is given', async () => {
    await openJobSession(URL, 'smdb-migrate:job-l5s2-01', 'job', 1234);
    expect(rig.configs).toHaveLength(1);
    expect(rig.configs[0]).toMatchObject({
      application_name: 'smdb-migrate:job-l5s2-01',
      options: `${KEEPALIVES} -c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c lock_timeout=1234`,
      connectionTimeoutMillis: 5000,
    });
    expect(rig.connects).toBe(1);
  });

  it('a probe session is bound to 2 s for its statements, its idle transaction and its locks', async () => {
    await openJobSession(URL, 'smdb-migrate:job-l5s2-02', 'probe', 1234);
    expect(rig.configs[0]).toMatchObject({
      options: `${KEEPALIVES} -c statement_timeout=2000 -c idle_in_transaction_session_timeout=2000 -c lock_timeout=2000`,
      connectionTimeoutMillis: 2000,
    });
  });

  it('a connect that fails ends the client and throws the connect\'s error', async () => {
    rig.connectError = new Error('connect ECONNREFUSED');
    await expect(openJobSession(URL, 'smdb-migrate:job-l5s2-03', 'job')).rejects.toThrow('connect ECONNREFUSED');
    expect(rig.connects).toBe(1);
    expect(rig.ends).toBe(1);
  });
});

describe('NB3 L5 s2: the drain of the web UI\'s guild writes', () => {
  it('keeps flushing until its bound has passed, then answers the guild paths still queued', async () => {
    const stuck = path.join(root, '660000000000000001', 'm', 'a.json');
    rig.queued = [stuck, path.join(root, '.backend.json')];
    const base = 1_000_000;
    // The clock moves 50 ms per flush: the bound of 100 ms passes exactly at the second flush.
    vi.spyOn(Date, 'now').mockImplementation(() => base + rig.flushes * 50);
    const answer = await drainGuildWrites(100);
    expect(answer).toEqual([stuck]);
    expect(rig.flushes).toBe(2);
  });

  it('answers nothing once the queue holds no guild path', async () => {
    rig.queued = [path.join(root, '.backend.json')];
    expect(await drainGuildWrites(100)).toEqual([]);
    expect(rig.flushes).toBe(1);
  });
});
