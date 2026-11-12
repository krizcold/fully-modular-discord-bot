import { describe, expect, it } from 'vitest';

import { readFacts, type SqlClient } from '../../src/bot/internalSetup/fleet/reshardStore';

interface Script {
  reshard?: Record<string, unknown> | null;
  claims?: Record<string, unknown>[];
  nodes?: Record<string, unknown>[];
}

function fakeClient(script: Script): SqlClient & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    async query(text: string) {
      texts.push(text);
      if (text.includes('AS meta_count')) return { rows: script.reshard ? [script.reshard] : [] };
      if (text.includes('FROM smdb_data.shard_claims')) return { rows: script.claims ?? [] };
      if (text.includes('FROM smdb_data.shard_nodes')) return { rows: script.nodes ?? [] };
      return { rows: [] };
    },
  };
}

const epochMs = (expr: string, alias: string) => `(extract(epoch FROM ${expr}) * 1000)::float8 AS ${alias}`;

const fullRow = {
  attempt: 'a-1', state: 'running', method: 'overlap', from_count: 2, to_count: 3, target: 3, target_by: 'm1',
  target_at: 1000, started_at: 2000, until_at: 3000, retry_after: 4000, failures: 3, reason: 'r',
  meta_count: 2, up_ms: '100', now_ms: 5000,
};

const node = (over: Record<string, unknown> = {}) => ({
  node_id: 'n1', node_name: 'm1', process_id: 'p1', fit: true, restartable: true, reshard_overlap: true,
  takeover_seconds: 30, seen_ago_ms: 0, started_ago_ms: 1234, memory_room: true, memory_free_mb: 100,
  memory_use_mb: 50, memory_error: null, memory_ago_ms: 5, ...over,
});

describe('ra29 readFacts SQL turns every time into epoch milliseconds', () => {
  it('reads the reshard row times and the clock as milliseconds', async () => {
    const c = fakeClient({ reshard: fullRow });
    await readFacts(c);
    const read = c.texts.find(t => t.includes('AS meta_count'))!;
    expect(read).toContain(epochMs('r.target_at', 'target_at'));
    expect(read).toContain(epochMs('r.started_at', 'started_at'));
    expect(read).toContain(epochMs('r.until_at', 'until_at'));
    expect(read).toContain(epochMs('r.retry_after', 'retry_after'));
    expect(read).toContain(epochMs('now()', 'now_ms'));
  });

  it('reads claim renewal age as milliseconds', async () => {
    const c = fakeClient({ reshard: fullRow });
    await readFacts(c);
    const read = c.texts.find(t => t.includes('FROM smdb_data.shard_claims'))!;
    expect(read).toContain(epochMs('(now() - renewed_at)', 'renewed_ago_ms'));
  });

  it('reads node seen, started and memory ages as milliseconds', async () => {
    const c = fakeClient({ reshard: fullRow });
    await readFacts(c);
    const read = c.texts.find(t => t.includes('FROM smdb_data.shard_nodes'))!;
    expect(read).toContain(epochMs('(now() - seen_at)', 'seen_ago_ms'));
    expect(read).toContain(epochMs('(now() - started_at)', 'started_ago_ms'));
    expect(read).toContain(epochMs('(now() - memory_at)', 'memory_ago_ms'));
  });
});

describe('ra29 readFacts row lock', () => {
  it('sends no FOR UPDATE when called without forUpdate', async () => {
    const c = fakeClient({ reshard: fullRow });
    await readFacts(c);
    expect(c.texts.some(t => t.includes('FOR UPDATE'))).toBe(false);
  });

  it('sends no FOR UPDATE when forUpdate is false', async () => {
    const c = fakeClient({ reshard: fullRow });
    await readFacts(c, false);
    expect(c.texts.some(t => t.includes('FOR UPDATE'))).toBe(false);
  });

  it('locks the reshard row before reading it when forUpdate is true', async () => {
    const c = fakeClient({ reshard: fullRow });
    await readFacts(c, true);
    const lock = c.texts.findIndex(t => t.includes('FROM smdb_data.reshard WHERE id = 1 FOR UPDATE'));
    const read = c.texts.findIndex(t => t.includes('AS meta_count'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(read);
  });
});

describe('ra29 readFacts values', () => {
  it('keeps null numbers as null, not 0', async () => {
    const c = fakeClient({
      reshard: { ...fullRow, from_count: null, to_count: null, target: null, meta_count: null },
      nodes: [node({ memory_free_mb: null })],
    });
    const facts = await readFacts(c);
    expect(facts.row.fromCount).toBeNull();
    expect(facts.row.toCount).toBeNull();
    expect(facts.row.target).toBeNull();
    expect(facts.metaCount).toBeNull();
    expect(facts.nodes[0].memoryFreeMb).toBeNull();
  });

  it('gives null numbers for a missing reshard row, not NaN', async () => {
    const c = fakeClient({ reshard: null, nodes: [node({ memory_free_mb: undefined, memory_ago_ms: undefined })] });
    const facts = await readFacts(c);
    expect(facts.row.fromCount).toBeNull();
    expect(facts.row.targetAtMs).toBeNull();
    expect(facts.metaCount).toBeNull();
    expect(facts.nodes[0].memoryFreeMb).toBeNull();
    expect(facts.nodes[0].memoryAgoMs).toBeNull();
  });

  it('keeps the stored method, target owner and failure count', async () => {
    const c = fakeClient({ reshard: fullRow });
    const facts = await readFacts(c);
    expect(facts.row.method).toBe('overlap');
    expect(facts.row.targetBy).toBe('m1');
    expect(facts.row.failures).toBe(3);
    expect(facts.row.fromCount).toBe(2);
    expect(facts.row.targetAtMs).toBe(1000);
  });

  it('keeps a node that is not fit, not restartable and refuses overlap as such', async () => {
    const c = fakeClient({ reshard: fullRow, nodes: [node({ fit: false, restartable: false, reshard_overlap: false })] });
    const facts = await readFacts(c);
    expect(facts.nodes[0].fit).toBe(false);
    expect(facts.nodes[0].restartable).toBe(false);
    expect(facts.nodes[0].reshardOverlap).toBe(false);
  });

  it('keeps a fit, restartable node that allows overlap', async () => {
    const c = fakeClient({ reshard: fullRow, nodes: [node({ reshard_overlap: null })] });
    const facts = await readFacts(c);
    expect(facts.nodes[0].fit).toBe(true);
    expect(facts.nodes[0].restartable).toBe(true);
    expect(facts.nodes[0].reshardOverlap).toBe(true);
  });

  it('keeps how long ago a node started', async () => {
    const c = fakeClient({ reshard: fullRow, nodes: [node({ started_ago_ms: 1234 })] });
    const facts = await readFacts(c);
    expect(facts.nodes[0].startedAgoMs).toBe(1234);
  });
});
