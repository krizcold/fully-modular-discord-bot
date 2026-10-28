import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { restoreGuildFromGraveyard, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';

// NB1 (wip-redesign/sheets/NB1.md, item 3): a fenced call whose token holds no usable claim is refused before any
// connection, touches no row, and leaves the outage state alone.

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

function readyBackend(): { backend: PostgresBackend; connect: ReturnType<typeof vi.fn> } {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
  backends.push(backend);
  (backend as unknown as { state: string }).state = 'ready';
  const connect = vi.fn(async () => { throw new Error('no connection may be opened'); });
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  return { backend, connect };
}

const calls = {
  hydrate: (b: PostgresBackend, t: FenceToken) => b.hydrateGuild('1', t),
  flush: (b: PostgresBackend, t: FenceToken) => b.flushGuild('1', { upserts: [{ key: { module: 'm', filename: 'a.json' }, doc: '{}' }], deletes: [], appends: [] }, t),
  retire: (b: PostgresBackend, t: FenceToken) => b.retireGuild('1', 'test', t),
  reclaim: (b: PostgresBackend, t: FenceToken) => b.reclaimGuild('1', t),
};
const answers: Record<keyof typeof calls, unknown> = {
  hydrate: { ok: false, reason: 'unavailable' },
  flush: { ok: false, reason: 'unavailable' },
  retire: { ok: false, reason: 'unavailable' },
  reclaim: null,
};
const claims: [string, number | null][] = [
  ['null', null],
  ['0', 0],
  ['-1', -1],
  ['1.5', 1.5],
  ['MAX_SAFE_INTEGER + 2', Number.MAX_SAFE_INTEGER + 2],
];

describe('a token with no usable claim', () => {
  it.each((Object.keys(calls) as (keyof typeof calls)[]).flatMap(op => claims.map(([name, claim]) => [op, name, claim] as const)))(
    '%s with claim %s is refused before any connection, with one log line and no outage',
    async (op, _name, claim) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { backend, connect } = readyBackend();
      const token = { nodeId: 'node-a', claim, shardId: 0, shardCount: 1 } as FenceToken;
      expect(await calls[op](backend, token)).toEqual(answers[op]);
      expect(connect).not.toHaveBeenCalled();
      expect(backend.connectionState().state).toBe('ready');
      const lines = [...error.mock.calls, ...warn.mock.calls, ...log.mock.calls].map(c => String(c[0]));
      expect(lines).toEqual([`[PostgresBackend] Refused ${op} for guild 1: this process holds no shard claim`]);
    },
  );
});

/** A backend whose pool hands out one scripted client; every statement it is sent is recorded. */
function scriptedBackend(answer: (sql: string) => unknown): { backend: PostgresBackend; sent: string[]; connect: ReturnType<typeof vi.fn> } {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
  backends.push(backend);
  (backend as unknown as { state: string }).state = 'ready';
  const sent: string[] = [];
  const client = {
    query: async (sql: string) => {
      sent.push(sql.trim());
      const res = answer(sql);
      if (res instanceof Error) throw res;
      return res ?? { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const connect = vi.fn(async () => client);
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  return { backend, sent, connect };
}

// NB1 round 1, F2: a database of another schema version is refused before any DDL runs in it, and the operator
// restore writes nothing into it.
describe('a database of another schema version', () => {
  const provision = (b: PostgresBackend) => (b as unknown as { provision(): Promise<void> }).provision();

  it('is refused before any statement creates or inserts anything', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend, sent } = scriptedBackend(sql => (
      /FROM smdb_data\.meta WHERE key = 'schema_version'/.test(sql) ? { rows: [{ value: '{"v":1}' }], rowCount: 1 } : undefined));
    await provision(backend);
    expect(sent.filter(s => /^(CREATE|INSERT|ALTER)/i.test(s))).toEqual([]);
    expect(await backend.provisionVerdict()).toEqual({ state: 'mismatch', found: '{"v":1}' });
    expect(backend.servesData()).toBe(false);
  });

  it('a database with no meta table yet is provisioned', async () => {
    const missing = Object.assign(new Error('relation "smdb_data.meta" does not exist'), { code: '42P01' });
    let created = false;
    const { backend, sent } = scriptedBackend(sql => {
      if (/CREATE TABLE IF NOT EXISTS smdb_data\.meta/.test(sql)) created = true;
      if (/SELECT value FROM smdb_data\.meta WHERE key = 'schema_version'/.test(sql)) {
        return created ? { rows: [{ value: '{"v":2}' }], rowCount: 1 } : missing;
      }
      return undefined;
    });
    await provision(backend);
    expect(sent.some(s => s.startsWith('CREATE SEQUENCE IF NOT EXISTS smdb_data.claim_seq'))).toBe(true);
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    expect(backend.servesData()).toBe(true);
  });

  it.each([
    ['latched', { schemaMismatch: true, provisioned: false }, 'schema-mismatch'],
    ['not yet provisioned', { schemaMismatch: false, provisioned: false }, 'not-provisioned'],
  ] as const)('a restore while the schema check is %s opens no connection and moves nothing', async (_name, flags, reason) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend, connect } = scriptedBackend(() => undefined);
    Object.assign(backend as unknown as object, flags);
    expect(await backend.restoreGuild('1', 5, { nodeId: '', claim: null, shardId: 0, shardCount: 1 })).toEqual({ ok: false, reason });
    expect(connect).not.toHaveBeenCalled();
  });

  it('the operator restore answers that the database holds another schema version', async () => {
    setBackendKind('postgres');
    setGuildDataBackend({ restoreGuild: async () => ({ ok: false, reason: 'schema-mismatch' }) } as never);
    try {
      expect(await restoreGuildFromGraveyard('1', 5)).toEqual({
        ok: false,
        error: 'the database holds another schema version than this bot reads; nothing was restored',
      });
    } finally {
      setGuildDataBackend(null);
      setBackendKind(null);
    }
  });
});

// NB1 round 1, F10: the deposed texts name the claim numbers.
describe('a deposed flush', () => {
  it('logs the stored owner and claim beside the local token and claim', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = scriptedBackend(sql => {
      if (/SELECT node_id, claim FROM smdb_data\.guild_ownership/.test(sql)) return { rows: [{ node_id: 'node-b', claim: '7' }], rowCount: 1 };
      return undefined;
    });
    (backend as unknown as { provisioned: boolean }).provisioned = true;
    const outcome = await backend.flushGuild('1', { upserts: [], deletes: [], appends: [] }, { nodeId: 'node-a', claim: 3, shardId: 0, shardCount: 1 });
    expect(outcome).toEqual({ ok: false, reason: 'deposed', currentOwner: { nodeId: 'node-b', claim: 7 } });
    expect(error.mock.calls.map(c => String(c[0]))).toContain(
      '[PostgresBackend] Flush rejected: deposed: guild 1 owned by node-b (claim 7); local token node-a (claim 3)');
  });

  it('leaves the working set\'s last error naming the newer owner\'s claim', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new FakeStore();
    const ws = new WorkingSetManager(store);
    expect(await ws.hydrate('77', tokenFor())).toBe('ready');
    expect(ws.save('77', 'm', 'a.json', '{"a":1}')).toBe('accepted');
    store.mode = 'deposed';
    expect(await ws.flushGuildNow('77', 2000)).toBe('deposed');
    expect(ws.getBackendHealth().lastError).toBe('guild 77 fenced by newer-owner (claim 9)');
    ws.evict('77');
  });
});
