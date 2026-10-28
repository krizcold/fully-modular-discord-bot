import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

type Answer = (sql: string, params?: unknown[]) => unknown;

function scripted(answer: Answer) {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
  backends.push(backend);
  (backend as unknown as { state: string }).state = 'ready';
  const sent: string[] = [];
  const releases: unknown[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
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
const VERSION_READ = /SELECT value FROM smdb_data\.meta WHERE key = 'schema_version'/;
const missing = () => Object.assign(new Error('relation "smdb_data.meta" does not exist'), { code: '42P01' });

describe('provisioning', () => {
  it('creates the guild_ownership table', async () => {
    quiet();
    let created = false;
    const { backend, sent } = scripted(sql => {
      if (/CREATE TABLE IF NOT EXISTS smdb_data\.meta/.test(sql)) created = true;
      if (VERSION_READ.test(sql)) return created ? { rows: [{ value: '{"v":2}' }], rowCount: 1 } : missing();
      return undefined;
    });
    await internals(backend).provision();
    expect(sent.some(s => /^CREATE TABLE IF NOT EXISTS smdb_data\.guild_ownership \(/.test(s))).toBe(true);
  });

  it('refuses a schema_version that is not JSON', async () => {
    quiet();
    const { backend } = scripted(sql => (VERSION_READ.test(sql) ? { rows: [{ value: 'garbage' }], rowCount: 1 } : undefined));
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'mismatch', found: 'garbage' });
  });

  it('refuses when another version was written between the first read and the insert', async () => {
    quiet();
    let created = false;
    const { backend, sent } = scripted(sql => {
      if (/CREATE TABLE IF NOT EXISTS smdb_data\.meta/.test(sql)) created = true;
      if (VERSION_READ.test(sql)) return created ? { rows: [{ value: '{"v":1}' }], rowCount: 1 } : missing();
      return undefined;
    });
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'mismatch', found: '{"v":1}' });
    expect(sent.some(s => s.includes("'store_id'"))).toBe(false);
  });

  it('a meta table with no version row is provisioned', async () => {
    quiet();
    let inserted = false;
    const { backend } = scripted(sql => {
      if (/INSERT INTO smdb_data\.meta \(key, value\) VALUES \('schema_version'/.test(sql)) inserted = true;
      if (VERSION_READ.test(sql)) return inserted ? { rows: [{ value: '{"v":2}' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      return undefined;
    });
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
  });

  it('names an unreadable version when the row is still missing after the insert', async () => {
    quiet();
    const { backend } = scripted(sql => (VERSION_READ.test(sql) ? { rows: [], rowCount: 0 } : undefined));
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'mismatch', found: 'unreadable' });
  });

  it('a version read that fails for another reason fails the provisioning and creates nothing', async () => {
    quiet();
    const { backend, sent } = scripted(sql => (
      VERSION_READ.test(sql) ? Object.assign(new Error('canceling statement'), { code: '57014' }) : undefined));
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
    await new Promise(resolve => { setTimeout(resolve, 10); });
    expect(verdict).toEqual({ state: 'stopped' });
  });
});

function claimBackend(nextval: unknown[], max: unknown[]) {
  const s = scripted(sql => {
    if (/nextval\('smdb_data\.claim_seq'\)/.test(sql)) return { rows: nextval, rowCount: nextval.length };
    if (/max\(claim\)/.test(sql)) return { rows: max, rowCount: max.length };
    return undefined;
  });
  internals(s.backend).provisioned = true;
  return s;
}

describe('taking a claim', () => {
  it('a negative sequence value is refused', async () => {
    const { backend, sent, releases } = claimBackend([{ claim: '-5' }], [{ claim: null }]);
    await expect(backend.takeClaim()).rejects.toThrow('unusable claim number -5');
    expect(sent).not.toContain('COMMIT');
    expect(releases).toEqual([true]);
  });

  it('a sequence value that is not a number is refused, naming the value', async () => {
    const { backend } = claimBackend([{ claim: 'abc' }], [{ claim: null }]);
    await expect(backend.takeClaim()).rejects.toThrow(/^unusable claim number abc$/);
  });

  it('a sequence value of 0 is raised to 1', async () => {
    const { backend, sent, releases } = claimBackend([{ claim: '0' }], [{ claim: null }]);
    expect(await backend.takeClaim()).toEqual({ outcome: 'claimed', claim: 1 });
    expect(sent).toContain('COMMIT');
    expect(releases).toEqual([undefined]);
  });

  it('a sequence query that returns no row is refused, naming the missing value', async () => {
    const { backend } = claimBackend([], [{ claim: null }]);
    await expect(backend.takeClaim()).rejects.toThrow(/^unusable claim number undefined$/);
  });

  it('a max query that returns no row leaves the sequence value', async () => {
    const { backend, releases } = claimBackend([{ claim: '7' }], []);
    expect(await backend.takeClaim()).toEqual({ outcome: 'claimed', claim: 7 });
    expect(releases).toEqual([undefined]);
  });

  it('a claim raised past the safe integers is refused and not committed', async () => {
    const { backend, sent, releases } = claimBackend([{ claim: '5' }], [{ claim: String(Number.MAX_SAFE_INTEGER) }]);
    await expect(backend.takeClaim()).rejects.toThrow(`unusable claim number ${Number.MAX_SAFE_INTEGER + 1}`);
    expect(sent).not.toContain('COMMIT');
    expect(releases).toEqual([true]);
  });
});

const token: FenceToken = { nodeId: 'node-a', claim: 3, shardId: 0, shardCount: 1 };
const emptyBatch = { upserts: [], deletes: [], appends: [] };

describe('flushing a guild', () => {
  it('a guild with no ownership row gets one and the flush commits', async () => {
    quiet();
    const { backend, sent } = scripted(sql => (
      /INSERT INTO smdb_data\.guild_ownership/.test(sql) ? { rows: [], rowCount: 1 } : undefined));
    expect(await backend.flushGuild('1', emptyBatch, token)).toEqual({ ok: true });
    expect(sent).toContain('COMMIT');
  });

  it('a deposed flush whose owner cannot be read names the owner unknown', async () => {
    quiet();
    const { backend } = scripted(() => undefined);
    const alerts: [string, string][] = [];
    backend.onAlert((event, detail) => { alerts.push([event, detail]); });
    expect(await backend.flushGuild('1', emptyBatch, token)).toEqual({ ok: false, reason: 'deposed', currentOwner: undefined });
    expect(alerts).toEqual([['deposed', 'deposed: guild 1 owned by unknown; local token node-a (claim 3)']]);
  });
});

describe('restoring a guild', () => {
  it('a provisioned backend opens a connection and checks for live rows', async () => {
    const { backend, connect } = scripted(sql => (/AS present/.test(sql) ? { rows: [{ present: true }], rowCount: 1 } : undefined));
    internals(backend).provisioned = true;
    expect(await backend.restoreGuild('1', 5, token)).toEqual({ ok: false, reason: 'live-rows' });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('logs why a restore is refused before provisioning', async () => {
    const error = quiet();
    const { backend } = scripted(() => undefined);
    await backend.restoreGuild('1', 5, token);
    expect(error.mock.calls.map(c => String(c[0]))).toEqual([
      '[PostgresBackend] Refused restore for guild 1: the database is not provisioned yet',
    ]);
  });

  it('logs the found version when a restore is refused on a schema mismatch', async () => {
    const error = quiet();
    const { backend } = scripted(sql => (VERSION_READ.test(sql) ? { rows: [{ value: '{"v":1}' }], rowCount: 1 } : undefined));
    await internals(backend).provision();
    error.mockClear();
    expect(await backend.restoreGuild('1', 5, token)).toEqual({ ok: false, reason: 'schema-mismatch' });
    expect(error.mock.calls.map(c => String(c[0]))).toEqual([
      '[PostgresBackend] Refused restore for guild 1: the database holds schema version {"v":1}',
    ]);
  });
});
