import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// NB4 decision 8: hydrate, flush and retire stamp the guild with one upsert that checks the shard's claim row for this
// process; reclaim carries the same check. Decision 16: a flush whose COMMIT got no answer says so.

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const b of backends.splice(0)) await b.stop();
});

const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'p-a', shardId: 2, shardCount: 4 };
const batch = { upserts: [{ key: { module: 'm', filename: 'a.json' }, doc: '{}' }], deletes: [], appends: [] };

function scripted(answer: (sql: string) => unknown) {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
  backends.push(backend);
  (backend as unknown as { state: string }).state = 'ready';
  const sent: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: async (q: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const sql = typeof q === 'string' ? q : q.text;
      const params = typeof q === 'string' ? values : q.values;
      sent.push({ sql: sql.trim(), params });
      const res = answer(sql);
      if (res instanceof Error) throw res;
      return res ?? { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
  return { backend, sent };
}

const stamped = (sql: string) => /INSERT INTO smdb_data\.guild_ownership AS o/.test(sql) ? { rows: [], rowCount: 1 } : undefined;

describe('the fenced stamp', () => {
  it.each([
    ['hydrate', (b: PostgresBackend) => b.hydrateGuild('g1', token)],
    ['flush', (b: PostgresBackend) => b.flushGuild('g1', batch, token)],
    ['retire', (b: PostgresBackend) => b.retireGuild('g1', 'test', token)],
  ])('%s sends one upsert with the claims check, binding count, shard, claim and process id', async (_name, call) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { backend, sent } = scripted(stamped);
    await call(backend);
    const stamps = sent.filter(s => /guild_ownership/.test(s.sql) && /shard_claims/.test(s.sql));
    expect(stamps).toHaveLength(1);
    expect(stamps[0].sql).toMatch(/EXISTS \(SELECT 1 FROM smdb_data\.shard_claims c\s+WHERE c\.shard_count = \$5 AND c\.shard_id = \$3 AND c\.claim = \$4 AND c\.holder_process = \$6 AND NOT c\.released\)/);
    expect(stamps[0].sql).toMatch(/ON CONFLICT \(guild_id\) DO UPDATE[\s\S]*WHERE o\.claim <= EXCLUDED\.claim/);
    expect(stamps[0].params).toEqual(['g1', 'node-a', 2, 7, 4, 'p-a']);
  });

  it('reclaim carries the claims check on its update and its insert', async () => {
    const { backend, sent } = scripted(() => undefined);
    expect(await backend.reclaimGuild('g1', token)).toBe('lost');
    const writes = sent.filter(s => /guild_ownership/.test(s.sql));
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.sql).toContain('c.holder_process = $6 AND NOT c.released');
      expect(w.params).toEqual(['g1', 'node-a', 2, 7, 4, 'p-a']);
    }
  });

  it.each([
    ['no claim', { ...token, claim: null }],
    ['no process id', { ...token, processId: null }],
  ])('a token with %s connects nothing', async (_name, t) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend, sent } = scripted(stamped);
    expect(await backend.flushGuild('g1', batch, t)).toEqual({ ok: false, reason: 'unavailable' });
    expect(sent).toEqual([]);
  });
});

describe('a COMMIT with no answer', () => {
  const failAt = (when: RegExp, error: Error) => (sql: string) => when.test(sql) ? error : stamped(sql);
  const ended = () => new Error('Connection terminated unexpectedly');

  it('a connection that ends after COMMIT was sent answers commitUnanswered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = scripted(failAt(/^COMMIT$/, ended()));
    expect(await backend.flushGuild('g1', batch, token)).toMatchObject({ ok: false, reason: 'unavailable', commitUnanswered: true });
  });

  it('a connection that ends on an earlier statement does not', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = scripted(failAt(/INSERT INTO smdb_data\.guild_data /, ended()));
    const outcome = await backend.flushGuild('g1', batch, token);
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(outcome).not.toHaveProperty('commitUnanswered');
  });

  it('a COMMIT answered with an ERROR does not', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = scripted(failAt(/^COMMIT$/, Object.assign(new Error('could not serialize access'), { code: '40001', severity: 'ERROR' })));
    const outcome = await backend.flushGuild('g1', batch, token);
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', code: '40001' });
    expect(outcome).not.toHaveProperty('commitUnanswered');
  });

  it.each(['FATAL', 'PANIC'])('a COMMIT ended by a %s answers commitUnanswered (NB13 decision 3)', async severity => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend, sent } = scripted(failAt(/^COMMIT$/, Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity })));
    expect(await backend.flushGuild('g1', batch, token)).toMatchObject({ ok: false, reason: 'unavailable', code: '57P01', commitUnanswered: true });
    expect(sent.filter(q => q.sql === 'COMMIT')).toHaveLength(1);
  });

  it('a FATAL on a statement before COMMIT does not', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend, sent } = scripted(failAt(/INSERT INTO smdb_data\.guild_data /, Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATAL' })));
    const outcome = await backend.flushGuild('g1', batch, token);
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', code: '57P01' });
    expect(outcome).not.toHaveProperty('commitUnanswered');
    expect(sent.some(q => q.sql === 'COMMIT')).toBe(false);
  });
});

describe("decision 9: the refusal names the shard's claim row by its state", () => {
  it.each([
    [{ claim: '9', holder_name: 'B', released: false, reserved: false }, 'shard 2 of 4 is held by claim 9 (B)'],
    [{ claim: '9', holder_name: 'B', released: true, reserved: true }, 'shard 2 of 4 is reserved by claim 9 (B) for its restart'],
    [{ claim: '7', holder_name: 'A', released: true, reserved: false }, 'shard 2 of 4 was released by claim 7 (kept for A)'],
    [null, 'shard 2 of 4 has no claim row'],
  ])('%s', async (row, part) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = scripted(sql => {
      if (/SELECT node_id, claim FROM smdb_data\.guild_ownership/.test(sql)) return { rows: [{ node_id: 'node-b', claim: '9' }], rowCount: 1 };
      if (/FROM smdb_data\.shard_claims WHERE shard_count = \$1 AND shard_id = \$2/.test(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      return undefined;
    });
    expect(await backend.flushGuild('g1', batch, token)).toMatchObject({ ok: false, reason: 'deposed' });
    const line = error.mock.calls.map(c => String(c[0])).find(l => l.startsWith('[PostgresBackend] Flush rejected'));
    expect(line).toBe(`[PostgresBackend] Flush rejected: deposed: guild g1 is held by claim 9 (node-b); ${part}; local claim 7`);
    expect(line).not.toMatch(row?.released ? /is held by claim \d+ \(A\)/ : /^$/);
  });
});
