import { describe, expect, it } from 'vitest';

import {
  callOffReshard, closeReshard, flipReshard, readFacts, startReshard, type SqlClient, type StartRequest,
} from '../../src/bot/internalSetup/fleet/reshardStore';

interface Script {
  reshard?: Record<string, unknown>;
  claims?: Record<string, unknown>[];
  nodes?: Record<string, unknown>[];
  deleteRows?: unknown[];
  updateRows?: unknown[];
  throwOn?: string;
}

interface Call { text: string; values?: unknown[] }

function fakeClient(script: Script): SqlClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (script.throwOn && text.includes(script.throwOn)) throw new Error('scripted failure');
      if (text.includes('AS meta_count')) return { rows: script.reshard ? [script.reshard] : [] };
      if (text.includes('FROM smdb_data.shard_claims') && text.trimStart().startsWith('SELECT')) return { rows: script.claims ?? [] };
      if (text.includes('FROM smdb_data.shard_nodes')) return { rows: script.nodes ?? [] };
      if (text.startsWith('DELETE FROM smdb_data.shard_claims') && text.includes('RETURNING')) return { rows: script.deleteRows ?? [] };
      if (text.startsWith('UPDATE smdb_data.reshard') && text.includes('RETURNING')) return { rows: script.updateRows ?? [] };
      return { rows: [] };
    },
  };
}

const ends = (c: { calls: Call[] }) => c.calls.map(x => x.text).filter(t => t === 'COMMIT' || t === 'ROLLBACK' || t === '');
const forUpdateSent = (c: { calls: Call[] }) => c.calls.some(x => x.text.includes('FOR UPDATE'));

const baseRow = {
  attempt: null, state: null, method: null, from_count: null, to_count: null, target: null, target_by: null,
  target_at: null, started_at: null, until_at: null, retry_after: null, failures: 0, reason: null,
  meta_count: 2, up_ms: '100000', now_ms: 5_000_000,
};
const claim = (shardCount: number, shardId: number) => ({
  shard_count: shardCount, shard_id: shardId, released: false, expires_up_ms: '200000', ready: true, ttl_ms: '30000',
  renewed_ago_ms: 0, holder_process: 'p1', holder_node: 'n1', holder_name: 'm1',
});

const start = (over: Partial<StartRequest> = {}): StartRequest => ({
  attempt: '00000000-0000-0000-0000-000000000001', wanted: 3, method: 'stop-start', reason: 'why', startedBy: 'm1',
  maxConcurrency: 1, ...over,
});

describe('ra30 readFacts', () => {
  it('keeps a node memory error and the stored clock as read', async () => {
    const c = fakeClient({
      reshard: { ...baseRow, up_ms: '123456' },
      nodes: [{
        node_id: 'n1', node_name: 'm1', process_id: 'p1', fit: true, restartable: true, reshard_overlap: true,
        takeover_seconds: 30, seen_ago_ms: 0, started_ago_ms: 10, memory_room: true, memory_free_mb: 100,
        memory_use_mb: 50, memory_error: 'cgroup unreadable', memory_ago_ms: 5,
      }],
    });
    const facts = await readFacts(c);
    expect(facts.nodes[0].memoryError).toBe('cgroup unreadable');
    expect(facts.upMs).toBe(123456);
  });
});

describe('ra30 inTransaction ends', () => {
  it('rolls back with ROLLBACK when the work throws', async () => {
    const c = fakeClient({ reshard: baseRow, throwOn: 'DELETE FROM smdb_data.shard_claims' });
    await expect(startReshard(c, start())).rejects.toThrow('scripted failure');
    expect(ends(c)).toEqual(['ROLLBACK']);
  });
});

describe('ra30 startReshard', () => {
  it('commits a start, locks the row, deletes with n and u, and writes stopping for stop-start', async () => {
    const c = fakeClient({ reshard: baseRow, deleteRows: [{}, {}] });
    const answer = await startReshard(c, start());
    expect(answer).toEqual({ kind: 'started', fromCount: 2, toCount: 3, untilSeconds: 600, deleted: 2 });
    expect(ends(c)).toEqual(['COMMIT']);
    expect(forUpdateSent(c)).toBe(true);
    const del = c.calls.find(x => x.text.startsWith('DELETE FROM smdb_data.shard_claims'))!;
    expect(del.values).toEqual([2, 100000]);
    const upd = c.calls.find(x => x.text.startsWith('UPDATE smdb_data.reshard'))!;
    expect(upd.values![4]).toBe('stopping');
  });

  it('writes standby for overlap', async () => {
    const c = fakeClient({ reshard: baseRow });
    await startReshard(c, start({ method: 'overlap', reason: null }));
    const upd = c.calls.find(x => x.text.startsWith('UPDATE smdb_data.reshard'))!;
    expect(upd.values![4]).toBe('standby');
  });

  it('rolls back a refused start and writes nothing', async () => {
    const c = fakeClient({ reshard: baseRow });
    const answer = await startReshard(c, start({ wanted: 2 }));
    expect(answer).toEqual({ kind: 'refused', why: 'count' });
    expect(ends(c)).toEqual(['ROLLBACK']);
    expect(c.calls.some(x => x.text.startsWith('UPDATE') || x.text.startsWith('DELETE'))).toBe(false);
  });
});

const flipRow = { ...baseRow, attempt: 'a', state: 'standby', method: 'overlap', from_count: 1, to_count: 2, meta_count: 1 };

describe('ra30 flipReshard', () => {
  it('commits a flip when every condition holds', async () => {
    const c = fakeClient({ reshard: flipRow, claims: [claim(2, 0), claim(2, 1)] });
    expect(await flipReshard(c, 'a')).toEqual({ kind: 'flipped', fromCount: 1, toCount: 2 });
    expect(ends(c)).toEqual(['COMMIT']);
  });

  it('answers not-yet, writes no meta and rolls back when a new shard is not ready', async () => {
    const c = fakeClient({ reshard: flipRow, claims: [claim(2, 0)] });
    const answer = await flipReshard(c, 'a');
    expect(answer.kind).toBe('not-yet');
    expect(c.calls.some(x => x.text.includes('UPDATE smdb_data.meta'))).toBe(false);
    expect(ends(c)).toEqual(['ROLLBACK']);
  });
});

const closeRow = { ...baseRow, attempt: 'a', state: 'flipped', method: 'overlap', from_count: 1, to_count: 2, meta_count: 2 };

describe('ra30 closeReshard', () => {
  it('commits a close', async () => {
    const c = fakeClient({ reshard: closeRow });
    expect(await closeReshard(c, 'a')).toEqual({ kind: 'closed', fromCount: 1, toCount: 2, expired: [] });
    expect(ends(c)).toEqual(['COMMIT']);
  });

  it('answers not-yet and rolls back while an old row is live', async () => {
    const c = fakeClient({ reshard: closeRow, claims: [claim(1, 0)] });
    const answer = await closeReshard(c, 'a');
    expect(answer.kind).toBe('not-yet');
    expect(c.calls.some(x => x.text.includes('DELETE FROM smdb_data.shard_claims'))).toBe(false);
    expect(ends(c)).toEqual(['ROLLBACK']);
  });
});

const callRow = {
  ...baseRow, attempt: 'a', state: 'standby', method: 'overlap', from_count: 1, to_count: 2, meta_count: 1,
  started_at: 4_000_000, until_at: 9_000_000,
};
const RETURNING = `RETURNING (extract(epoch FROM retry_after) * 1000)::float8 AS retry_after`;

describe('ra30 callOffReshard', () => {
  it('commits a call-off, locks the row and returns the stored retry_after', async () => {
    const c = fakeClient({ reshard: callRow, updateRows: [{ retry_after: 7_000_000 }] });
    const answer = await callOffReshard(c, 'a', { reason: 'fork refused', countsFailure: true });
    expect(answer).toEqual({
      kind: 'called-off', attempt: 'a', fromCount: 1, toCount: 2, reason: 'fork refused', retryAfterMs: 7_000_000, retryNow: false,
    });
    expect(ends(c)).toEqual(['COMMIT']);
    expect(forUpdateSent(c)).toBe(true);
    const upd = c.calls.find(x => x.text.startsWith('UPDATE smdb_data.reshard'))!;
    expect(upd.text).toContain(RETURNING);
  });

  it('answers now when the update matched no row', async () => {
    const c = fakeClient({ reshard: callRow, updateRows: [] });
    const answer = await callOffReshard(c, 'a', { reason: 'fork refused', countsFailure: false });
    expect(answer.kind).toBe('called-off');
    expect(answer.kind === 'called-off' && answer.retryAfterMs).toBe(5_000_000);
  });

  it('leaves another attempt alone and rolls back', async () => {
    const c = fakeClient({ reshard: callRow });
    const answer = await callOffReshard(c, 'b', { reason: 'fork refused', countsFailure: true });
    expect(answer.kind).toBe('none');
    expect(c.calls.some(x => x.text.startsWith('UPDATE'))).toBe(false);
    expect(ends(c)).toEqual(['ROLLBACK']);
  });

  it('rolls back when no reason calls the attempt off', async () => {
    const c = fakeClient({ reshard: callRow });
    const answer = await callOffReshard(c, 'a');
    expect(answer.kind).toBe('none');
    expect(ends(c)).toEqual(['ROLLBACK']);
  });
});
