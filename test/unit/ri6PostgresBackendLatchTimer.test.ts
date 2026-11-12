import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { freshVersionRefusal } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';

const URL = 'postgres://nobody@127.0.0.1:9/none';
const backends: PostgresBackend[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const backend of backends.splice(0)) await backend.stop();
  vi.restoreAllMocks();
});

function silentChooser(): DatabaseChooser {
  return {
    chosen: () => URL,
    awaitChoice: async () => URL,
    lastPassLogin: () => 'unreachable',
    holdStarted() {},
    confirmNow() {},
    stop() {},
  };
}

const VERSION_READ = /SELECT value::text FROM ONLY smdb_data\.meta WHERE key = 'schema_version'/;

function freshStoreReadingOtherVersion(sql: string): unknown {
  if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
  if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: 'UTF8' }], rowCount: 1 };
  if (/has_database_privilege/.test(sql)) {
    return {
      rows: [{
        role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: false, schema_usage: null,
        schema_create: null, relations: [], meta: null,
      }],
      rowCount: 1,
    };
  }
  if (VERSION_READ.test(sql)) return { rows: [{ value: '{"v":1}' }], rowCount: 1 };
  return undefined;
}

describe('a refused store latched while a hold had armed the outage alert', () => {
  it('leaves no outage-alert timer pending once the refusal latches', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    expect(SCHEMA_VERSION).not.toBe(1);

    const backend = new PostgresBackend({ chooser: silentChooser() });
    backends.push(backend);
    (backend as unknown as { state: string }).state = 'ready';

    let rollbackSent!: () => void;
    const rollbackSeen = new Promise<void>(resolve => { rollbackSent = resolve; });
    let answerRollback!: () => void;
    const rollbackAnswer = new Promise<void>(resolve => { answerRollback = resolve; });
    const alerts: [string, string][] = [];
    backend.onAlert((event, detail) => { alerts.push([event, detail]); });

    const client = {
      query: async (statement: string | { text: string }) => {
        const sql = (typeof statement === 'string' ? statement : statement.text).trim();
        if (sql === 'ROLLBACK') {
          rollbackSent();
          await rollbackAnswer;
          return { rows: [], rowCount: 0 };
        }
        return freshStoreReadingOtherVersion(sql) ?? { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    (backend.getPool() as unknown as { connect: unknown }).connect = async () => client;

    const before = vi.getTimerCount();
    const provisioning = (backend as unknown as { provision(): Promise<void> }).provision();
    await rollbackSeen;
    backend.noteLapse();
    expect(vi.getTimerCount()).toBe(before + 1);
    answerRollback();
    await provisioning;

    const refusal = freshVersionRefusal(`smdb_data.meta's schema_version reads {"v":1}`);
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(alerts).toEqual([['outage', refusal.header]]);
    expect(vi.getTimerCount()).toBe(before);
  });
});
