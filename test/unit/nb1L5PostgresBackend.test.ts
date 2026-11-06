import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { freshVersionRefusal } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

type Answer = (sql: string, params?: unknown[]) => unknown;

function scripted(answer: Answer) {
  const backend = new PostgresBackend(fixedDatabase('postgres://nobody@127.0.0.1:9/none'));
  backends.push(backend);
  (backend as unknown as { state: string }).state = 'ready';
  const sent: string[] = [];
  const releases: unknown[] = [];
  const client = {
    query: async (statement: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const sql = typeof statement === 'string' ? statement : statement.text;
      const params = values ?? (typeof statement === 'string' ? undefined : statement.values);
      sent.push(sql.trim());
      const res = answer(sql, params);
      if (res instanceof Error) throw res;
      return res ?? { rows: [], rowCount: 0 };
    },
    release: (arg?: unknown) => { releases.push(arg); },
  };
  const connect = vi.fn(async () => client);
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  return { backend, sent, releases, connect };
}

const internals = (b: PostgresBackend) => b as unknown as { provision(): Promise<void>; provisioned: boolean; schemaMismatch: boolean };
const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return vi.spyOn(console, 'error').mockImplementation(() => {});
};
const VERSION_READ = /SELECT value::text FROM ONLY smdb_data\.meta WHERE key = 'schema_version'/;
const META = { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true, select: true };
const tableRow = (name: string) => ({ name, kind: 'r', is_partition: false, select: true, insert: true, update: true, delete: true, usage: null, update_seq: null });

// NB16: the bootstrap lock is free, the encoding answers UTF8, and the found list holds either nothing (a fresh
// database) or a meta that passes the gate (a store); the rest is the test's script.
function onStore(withMeta: boolean, answer: Answer): Answer {
  return (sql, params) => {
    if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: 'UTF8' }], rowCount: 1 };
    if (/has_database_privilege/.test(sql)) {
      return {
        rows: [{
          role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: withMeta, schema_usage: withMeta ? true : null,
          schema_create: withMeta ? true : null, relations: withMeta ? [tableRow('meta')] : [], meta: withMeta ? META : null,
        }],
        rowCount: 1,
      };
    }
    return answer(sql, params);
  };
}

describe('provisioning', () => {
  it('creates the guild_ownership table', async () => {
    quiet();
    const { backend, sent } = scripted(onStore(false, sql => (VERSION_READ.test(sql) ? { rows: [{ value: JSON.stringify({ v: SCHEMA_VERSION }) }], rowCount: 1 } : undefined)));
    await internals(backend).provision();
    expect(sent.some(s => /^CREATE TABLE IF NOT EXISTS smdb_data\.guild_ownership \(/.test(s))).toBe(true);
  });

  it('refuses a schema_version that is not JSON', async () => {
    quiet();
    const { backend } = scripted(onStore(true, sql => (VERSION_READ.test(sql) ? { rows: [{ value: 'garbage' }], rowCount: 1 } : undefined)));
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'mismatch', found: 'garbage' });
  });

  it('refuses the schema it made, rolled back, when another version reads back after the insert', async () => {
    quiet();
    const { backend, sent } = scripted(onStore(false, sql => (VERSION_READ.test(sql) ? { rows: [{ value: '{"v":1}' }], rowCount: 1 } : undefined)));
    await internals(backend).provision();
    const refusal = freshVersionRefusal(`smdb_data.meta's schema_version reads {"v":1}`);
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(sent.some(s => s.includes("'store_id'"))).toBe(false);
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
  });

  it('refuses the schema it made, rolled back, when the version row is still missing after the insert', async () => {
    quiet();
    const { backend, sent } = scripted(onStore(false, sql => (VERSION_READ.test(sql) ? { rows: [], rowCount: 0 } : undefined)));
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: freshVersionRefusal('smdb_data.meta holds no schema_version row').reason, fix: freshVersionRefusal('').fix });
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
  });

  it('a version read that fails for another reason fails the provisioning and creates nothing', async () => {
    quiet();
    const { backend, sent } = scripted(onStore(true, sql => (
      VERSION_READ.test(sql) ? Object.assign(new Error('canceling statement'), { code: '57014' }) : undefined)));
    await expect(internals(backend).provision()).rejects.toThrow('canceling statement');
    expect(sent.filter(s => /^(CREATE|INSERT)/i.test(s))).toEqual([]);
    expect(internals(backend).schemaMismatch).toBe(false);
  });
});

describe('the provisioning verdict', () => {
  it('a fresh backend does not serve data', () => {
    const { backend } = scripted(() => undefined);
    expect(backend.servesData()).toBe(false);
  });

  it('answers stopped once stopped, even when provisioned', async () => {
    const { backend } = scripted(() => undefined);
    internals(backend).provisioned = true;
    await backend.stop();
    expect(await backend.provisionVerdict()).toEqual({ state: 'stopped' });
  });

  it('waits while provisioning has not passed, and answers stopped at the stop', async () => {
    const { backend } = scripted(() => undefined);
    let verdict: unknown;
    void backend.provisionVerdict().then(v => { verdict = v; });
    await new Promise(resolve => { setTimeout(resolve, 30); });
    expect(verdict).toBeUndefined();
    await backend.stop();
    const deadline = Date.now() + 5_000;
    while (verdict === undefined && Date.now() < deadline) await new Promise(r => setTimeout(r, 2));
    expect(verdict).toEqual({ state: 'stopped' });
  });
});

const token: FenceToken = { nodeId: 'node-a', claim: 3, processId: 'process-a', shardId: 0, shardCount: 1 };
const emptyBatch = { upserts: [], deletes: [], appends: [] };

describe('flushing a guild', () => {
  it('a guild with no ownership row gets one and the flush commits', async () => {
    quiet();
    const { backend, sent } = scripted(sql => (
      /INSERT INTO smdb_data\.guild_ownership/.test(sql) ? { rows: [], rowCount: 1 } : undefined));
    expect(await backend.flushGuild('1', emptyBatch, token)).toEqual({ ok: true });
    expect(sent).toContain('COMMIT');
  });

  it('a deposed flush with no ownership row and no claim row names both', async () => {
    quiet();
    const { backend } = scripted(() => undefined);
    const alerts: [string, string][] = [];
    backend.onAlert((event, detail) => { alerts.push([event, detail]); });
    expect(await backend.flushGuild('1', emptyBatch, token)).toEqual({ ok: false, reason: 'deposed', currentOwner: undefined });
    expect(alerts).toEqual([['deposed', 'deposed: guild 1 has no ownership row; shard 0 of 1 has no claim row; local claim 3']]);
  });
});

const RESTORE_ARGS = () => [() => null, process.hrtime.bigint() + 40_000_000_000n] as const;

describe('restoring a guild', () => {
  it('a provisioned backend opens a connection and checks for live rows', async () => {
    const { backend, connect } = scripted(sql => (/AS present/.test(sql) ? { rows: [{ present: true }], rowCount: 1 } : /SET node_id|AND retired_at = \$2 LIMIT 1/.test(sql) ? { rows: [], rowCount: 1 } : undefined));
    internals(backend).provisioned = true;
    expect(await backend.restoreGuild('1', 5, token, ...RESTORE_ARGS())).toEqual({ ok: false, reason: 'live-rows', retiredAt: 5 });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('logs why a restore is refused before provisioning', async () => {
    const error = quiet();
    const { backend } = scripted(() => undefined);
    await backend.restoreGuild('1', 5, token, ...RESTORE_ARGS());
    expect(error.mock.calls.map(c => String(c[0]))).toEqual([
      '[PostgresBackend] Refused restore for guild 1: the database is not provisioned yet',
    ]);
  });

  it('logs the found version when a restore is refused on a schema mismatch', async () => {
    const error = quiet();
    const { backend } = scripted(onStore(true, sql => (VERSION_READ.test(sql) ? { rows: [{ value: '{"v":1}' }], rowCount: 1 } : undefined)));
    await internals(backend).provision();
    error.mockClear();
    expect(await backend.restoreGuild('1', 5, token, ...RESTORE_ARGS())).toEqual({ ok: false, reason: 'schema-mismatch' });
    expect(error.mock.calls.map(c => String(c[0]))).toEqual([
      '[PostgresBackend] Refused restore for guild 1: the database holds schema version {"v":1}',
    ]);
  });
});
