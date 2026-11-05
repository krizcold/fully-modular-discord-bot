import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';

// NB4's fenced transactions on a scripted pool client: a process without a usable shard claim touches no row, a
// claim that lost the guild is answered deposed, and the deposed flush names the shard row it read.

type Answer = { rows: unknown[]; rowCount: number };
type Script = (sql: string, params: unknown[] | undefined) => Answer | Promise<Answer>;

const backends: PostgresBackend[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const b of backends.splice(0)) await b.stop();
});

const TOKEN: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'p-a', shardId: 3, shardCount: 4 };
const EMPTY = { upserts: [], deletes: [], appends: [] };
const none: Answer = { rows: [], rowCount: 0 };

function rig(script: Script, state: 'ready' | 'outage' | 'connecting' = 'connecting') {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
  backends.push(backend);
  (backend as unknown as { state: string }).state = state;
  const queries: string[] = [];
  const client = {
    query: async (q: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const sql = typeof q === 'string' ? q : q.text;
      queries.push(sql.trim());
      return script(sql.trim(), typeof q === 'string' ? values : q.values);
    },
    release: () => {},
  };
  const connect = vi.fn(async () => client);
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  const alerts: string[] = [];
  backend.onAlert(((kind: string, detail: string) => { alerts.push(`${kind}: ${detail}`); }) as never);
  return { backend, queries, connect, errors, alerts };
}

const isUpsert = (q: string) => /INSERT INTO smdb_data\.guild_ownership AS o/.test(q);
const isOwner = (q: string) => /SELECT node_id, claim FROM smdb_data\.guild_ownership/.test(q);
const isShardRow = (q: string) => /FROM smdb_data\.shard_claims WHERE shard_count = \$1 AND shard_id = \$2/.test(q);
const owner: Answer = { rows: [{ node_id: 'node-b', claim: '20' }], rowCount: 1 };

describe('a process with no usable claim', () => {
  it('touches no row when its process id is not a string', async () => {
    const { backend, connect, errors } = rig(() => none);
    const token = { ...TOKEN, processId: 42 } as unknown as FenceToken;
    expect(await backend.hydrateGuild('777', token)).toEqual({ ok: false, reason: 'unavailable' });
    expect(connect).not.toHaveBeenCalled();
    expect(errors).toEqual(['[PostgresBackend] Refused hydrate for guild 777: this process holds no shard claim']);
  });
});

describe('a hydrate whose claim lost the guild', () => {
  it('answers deposed with the current owner and reads no document', async () => {
    const { backend, queries } = rig(q => (isOwner(q) ? owner : q.startsWith('SELECT module') ? { rows: [{ module: 'm', filename: 'a.json', doc: '1' }], rowCount: 1 } : none));
    expect(await backend.hydrateGuild('777', TOKEN)).toEqual({ ok: false, reason: 'deposed', currentOwner: { nodeId: 'node-b', claim: 20 } });
    expect(queries.some(q => q.includes('smdb_data.guild_data '))).toBe(false);
    expect(queries).toContain('ROLLBACK');
  });
});

describe('a reclaim', () => {
  it('a stamp moved by the first statement is kept, with no insert after it', async () => {
    let n = 0;
    const { backend, queries } = rig(() => ({ rows: [], rowCount: ++n === 1 ? 1 : 0 }));
    expect(await backend.reclaimGuild('777', TOKEN)).toBe('kept');
    expect(queries).toHaveLength(1);
  });
});

describe('a deposed flush names the shard row', () => {
  it('a shard row read that fails says it could not be read', async () => {
    const { backend, errors, alerts } = rig(q => {
      if (isOwner(q)) return owner;
      if (isShardRow(q)) throw new Error('connection reset');
      return none;
    });
    expect(await backend.flushGuild('777', EMPTY, TOKEN)).toEqual({ ok: false, reason: 'deposed', currentOwner: { nodeId: 'node-b', claim: 20 } });
    const detail = "deposed: guild 777 is held by claim 20 (node-b); shard 3 of 4's claim row could not be read; local claim 7";
    expect(errors).toEqual([`[PostgresBackend] Flush rejected: ${detail}`]);
    expect(alerts).toEqual([`deposed: ${detail}`]);
  });

  it('reads the row of the token\'s own shard', async () => {
    const { backend, errors } = rig((q, params) => {
      if (isOwner(q)) return owner;
      if (isShardRow(q)) {
        const mine = JSON.stringify(params) === JSON.stringify([4, 3]);
        return mine ? { rows: [{ claim: '20', holder_name: 'B', released: false, reserved: false }], rowCount: 1 } : none;
      }
      return none;
    });
    await backend.flushGuild('777', EMPTY, TOKEN);
    expect(errors).toEqual(['[PostgresBackend] Flush rejected: deposed: guild 777 is held by claim 20 (node-b); shard 3 of 4 is held by claim 20 (B); local claim 7']);
  });
});

describe('a flush whose driver throws a bare null', () => {
  it('answers unavailable instead of throwing', async () => {
    const { backend } = rig(() => { throw null; });
    await expect(backend.flushGuild('777', EMPTY, TOKEN)).resolves.toEqual({ ok: false, reason: 'unavailable', detail: 'null' });
  });

  it('answers unavailable for a thrown function too, reading nothing off it', async () => {
    const thrown = Object.defineProperty(function failed() {}, 'severity', { get() { throw new Error('read'); } });
    const { backend } = rig(() => { throw thrown; });
    await expect(backend.flushGuild('777', EMPTY, TOKEN)).resolves.toEqual({ ok: false, reason: 'unavailable', detail: String(thrown) });
  });
});

describe('a retire whose claim lost the guild', () => {
  it('rolls back, answers deposed, and the answer ends an outage', async () => {
    const { backend, queries } = rig(() => none, 'outage');
    expect(backend.connectionState().state).toBe('outage');
    expect(await backend.retireGuild('777', 'left', TOKEN)).toEqual({ ok: false, reason: 'deposed' });
    expect(queries[0]).toBe('BEGIN');
    expect(isUpsert(queries[1])).toBe(true);
    expect(queries[2]).toBe('ROLLBACK');
    expect(queries).toHaveLength(3);
    expect(backend.connectionState().state).toBe('ready');
  });
});
