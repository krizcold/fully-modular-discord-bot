import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { HYDRATE_BYTES_SQL, HYDRATE_ROW_OVERHEAD_BYTES, PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { flushBoundMs } from '../../src/bot/internalSetup/utils/storableData';

// NB20: the hydrate's reads run under a statement_timeout sized by the guild's stored bytes, as a flush's is (NB12),
// set with SET LOCAL inside the hydrate's transaction.

const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'p-a', shardId: 2, shardCount: 4 };
const isFence = (s: string) => /^INSERT INTO smdb_data\.guild_ownership AS o\b/.test(s);
const isSize = (s: string) => /octet_length/.test(s) && /guild_data/.test(s);
const isAppendRead = (s: string) => /^SELECT DISTINCT module, filename FROM smdb_data.guild_append WHERE guild_id/.test(s);
const isDocsRead = (s: string) => /^SELECT module, filename, doc FROM smdb_data\.guild_data WHERE guild_id/.test(s);

const backends: PostgresBackend[] = [];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const b of backends.splice(0)) await b.stop().catch(() => undefined);
});

function rig(bytes: string | null) {
  const sent: string[] = [];
  const client = {
    query(config: string | { text: string }) {
      const sql = (typeof config === 'string' ? config : config.text).trim();
      sent.push(sql);
      if (isFence(sql)) return Promise.resolve({ rows: [], rowCount: 1 });
      if (isSize(sql)) return Promise.resolve({ rows: bytes === null ? [] : [{ bytes }], rowCount: 1 });
      if (isDocsRead(sql)) return Promise.resolve({ rows: [{ module: 'm', filename: 'a.json', doc: '{}' }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {},
  };
  const pool = { connect: vi.fn(async () => client), query: vi.fn(), end: vi.fn(async () => undefined), on: () => pool };
  const backend = new PostgresBackend({ chooser: { chosen: () => 'postgres://bot@db1:5432/bot', awaitChoice: async () => 'postgres://bot@db1:5432/bot', lastPassLogin: () => 'unreachable', holdStarted: vi.fn(), confirmNow: vi.fn(), stop: () => undefined } } as never);
  backends.push(backend);
  backend.getPool();
  const internals = backend as unknown as { pool: unknown; state: string; provisioned: boolean };
  internals.pool = pool;
  internals.state = 'ready';
  internals.provisioned = true;
  return { backend, sent };
}

describe('NB20: the hydrate bound', () => {
  it.each([
    ['a guild of 196 KB', '200704', flushBoundMs(200704)],
    ['a guild of 4 MiB', String(4 * 1024 * 1024), flushBoundMs(4 * 1024 * 1024)],
    ['an empty guild', '0', flushBoundMs(0)],
    ['a guild with no size row', null, flushBoundMs(0)],
    ['a guild of 200000 empty documents', String(200_000 * (HYDRATE_ROW_OVERHEAD_BYTES + 'm'.length + 'a.json'.length + '{}'.length)), flushBoundMs(200_000 * (HYDRATE_ROW_OVERHEAD_BYTES + 9))],
  ])('%s: SET LOCAL statement_timeout sized by its bytes runs inside the transaction before the reads', async (_name, bytes, bound) => {
    const { backend, sent } = rig(bytes);
    expect(await backend.hydrateGuild('1', token)).toMatchObject({ ok: true });
    const set = sent.findIndex(s => s === `SET LOCAL statement_timeout = ${bound}`);
    expect(set).toBeGreaterThan(sent.findIndex(s => s === 'BEGIN'));
    expect(set).toBeGreaterThan(sent.findIndex(isSize));
    expect(set).toBeLessThan(sent.findIndex(isDocsRead));
    expect(set).toBeLessThan(sent.findIndex(isAppendRead));
    expect(sent.find(isSize)).toBe(HYDRATE_BYTES_SQL);
    expect(sent.findIndex(s => s === 'COMMIT')).toBeGreaterThan(sent.findIndex(isDocsRead));
    expect(sent.filter(s => /statement_timeout/.test(s) && !/LOCAL/.test(s))).toEqual([]);
  });
});

describe('NB20: the size statement', () => {
  it('counts each document row and each append-key row with its wire framing', () => {
    expect(HYDRATE_ROW_OVERHEAD_BYTES).toBe(7 + 3 * 4);
    expect(HYDRATE_BYTES_SQL).toContain(`octet_length(doc) + ${HYDRATE_ROW_OVERHEAD_BYTES}), 0) FROM smdb_data.guild_data WHERE guild_id = $1`);
    expect(HYDRATE_BYTES_SQL).toContain(`octet_length(filename) + ${HYDRATE_ROW_OVERHEAD_BYTES}), 0) FROM (SELECT DISTINCT module, filename FROM smdb_data.guild_append WHERE guild_id = $1)`);
  });

  it('many small rows raise the bound past what their raw bytes alone give', () => {
    const rows = 200_000;
    const raw = rows * 9;
    expect(flushBoundMs(raw + rows * HYDRATE_ROW_OVERHEAD_BYTES)).toBeGreaterThan(flushBoundMs(raw));
  });
});
