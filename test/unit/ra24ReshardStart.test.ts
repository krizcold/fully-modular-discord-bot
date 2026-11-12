import { describe, expect, it } from 'vitest';

import { Reshard, l1Line, l18Line, l19Line, l2Line, type ReshardBudget } from '../../src/bot/internalSetup/fleet/reshard';
import { untilSeconds } from '../../src/bot/internalSetup/fleet/reshardRules';
import type { PageRead } from '../../src/bot/internalSetup/fleet/claimStore';
import type { SqlClient } from '../../src/bot/internalSetup/fleet/reshardStore';

const ATTEMPT = 'a1b2c3d4-0000-4000-8000-0000000000aa';
const RESET_AT = Date.UTC(2026, 10, 11, 12, 0);

interface NodeSpec {
  name: string;
  id?: string;
  restartable?: boolean;
  overlap?: boolean;
  seenAgoMs?: number;
  takeoverSeconds?: number;
}

interface RowSpec {
  state?: string | null;
  attempt?: string | null;
  fromCount?: number | null;
  toCount?: number | null;
  failures?: number;
  metaCount: number;
}

function dbNode(n: NodeSpec, i: number) {
  return {
    node_id: n.id ?? `node-${n.name}-${i}`, node_name: n.name, process_id: `p-${i}`, fit: true,
    restartable: n.restartable ?? true, reshard_overlap: n.overlap ?? true, takeover_seconds: n.takeoverSeconds ?? 30,
    seen_ago_ms: n.seenAgoMs ?? 1000, started_ago_ms: 3_600_000, memory_room: true, memory_free_mb: 4000,
    memory_use_mb: 500, memory_error: null, memory_ago_ms: 1000,
  };
}

function fakeDb(row: RowSpec, nodes: NodeSpec[]) {
  const updates: unknown[][] = [];
  const client: SqlClient = {
    async query(text: string, values?: unknown[]) {
      if (text.includes('LEFT JOIN smdb_data.reshard r')) {
        return {
          rows: [{
            attempt: row.attempt ?? null, state: row.state ?? null, method: null, from_count: row.fromCount ?? null,
            to_count: row.toCount ?? null, target: null, target_by: null, target_at: null, started_at: null, until_at: null,
            retry_after: null, failures: row.failures ?? 0, reason: null, meta_count: row.metaCount, up_ms: '1000', now_ms: 5000,
          }],
        };
      }
      if (text.includes('FROM smdb_data.shard_nodes')) return { rows: nodes.map(dbNode) };
      if (/^\s*UPDATE smdb_data\.reshard/.test(text)) updates.push(values ?? []);
      return { rows: [] };
    },
  };
  return { client, updates };
}

function run(opts: {
  page: number;
  target?: number | null;
  recommendation?: number | null;
  row: RowSpec;
  nodes: NodeSpec[];
  remaining?: number;
}) {
  const { client, updates } = fakeDb(opts.row, opts.nodes);
  const logs: string[] = [];
  const warns: string[] = [];
  const labels: string[] = [];
  const budget: ReshardBudget = { stale: false, remaining: opts.remaining ?? 1000, resetAt: RESET_AT };
  const driver = new Reshard({
    claims: { processId: 'p-0', ownCount: () => opts.page, stopServingForReshard: () => true, noteHandOver: () => undefined },
    withWorkClient: async (what, fn) => { labels.push(what); return fn(client as any); },
    me: { nodeId: 'node-me', nodeName: 'me' }, fitness: () => null, restartable: true,
    startLeave: () => undefined, send: () => undefined, intents: () => 513, maxConcurrency: () => 1,
    entry: () => 'db', budget: () => budget, recommendation: () => opts.recommendation ?? null,
    newAttempt: () => ATTEMPT,
    log: { log: (l: string) => logs.push(l), warn: (l: string) => warns.push(l), error: (l: string) => warns.push(l) },
    now: () => RESET_AT - 3_600_000,
  });
  const page: PageRead = {
    shardCount: opts.page, upMs: 1000, uPrimeMs: 1000, rows: [], nodes: [],
    reshard: { attempt: null, state: null, fromCount: null, toCount: null, metaCount: opts.page, target: opts.target ?? null },
  };
  return { driver, page, logs, warns, labels, updates };
}

const overlapLine = (n: number, w: number) => l1Line(n, w, Math.round(untilSeconds('overlap', w, 1) / 60));

describe('ra24: which machines count as live for the method choice', () => {
  it('a machine last seen exactly at its takeover time is not live, so it does not rule overlap out', async () => {
    const r = run({
      page: 4, target: 6, row: { metaCount: 4 },
      nodes: [{ name: 'a' }, { name: 'z', restartable: false, seenAgoMs: 30_000, takeoverSeconds: 30 }],
    });
    await r.driver.onPage(r.page);
    expect(r.logs).toEqual([overlapLine(4, 6)]);
    expect(r.warns).toEqual([]);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0][3]).toBe('overlap');
  });

  it('a stop-start names only the live machines without the web UI, sorted by name', async () => {
    const r = run({
      page: 4, target: 6, row: { metaCount: 4 },
      nodes: [
        { name: 'z', restartable: false, seenAgoMs: 5000, takeoverSeconds: 30 },
        { name: 'b', seenAgoMs: 5000, takeoverSeconds: 30 },
        { name: 'm', restartable: false, seenAgoMs: 5000, takeoverSeconds: 30 },
      ],
    });
    await r.driver.onPage(r.page);
    expect(r.logs).toEqual([]);
    expect(r.warns).toEqual([l2Line(4, 6, 'm runs without the web UI', ['m', 'z'])]);
    expect(r.warns[0]).toContain('; m, z run without the web UI and stay stopped until started by hand');
    expect(r.updates[0][3]).toBe('stop-start');
  });
});

describe('ra24: the failures the method choice counts', () => {
  it('two called-off tries toward the same count make the start stop-start', async () => {
    const r = run({ page: 4, target: 6, row: { metaCount: 4, state: 'cancelled', fromCount: 4, toCount: 6, failures: 2 }, nodes: [{ name: 'a' }] });
    await r.driver.onPage(r.page);
    expect(r.logs).toEqual([]);
    expect(r.warns).toEqual([l2Line(4, 6, 'two tries beside the running shards were called off', [])]);
    expect(r.updates[0][3]).toBe('stop-start');
  });

  it('called-off tries toward another count do not count, so the start is overlap', async () => {
    const r = run({ page: 4, target: 6, row: { metaCount: 4, state: 'cancelled', fromCount: 4, toCount: 5, failures: 2 }, nodes: [{ name: 'a' }] });
    await r.driver.onPage(r.page);
    expect(r.warns).toEqual([]);
    expect(r.logs).toEqual([overlapLine(4, 6)]);
    expect(r.updates[0][3]).toBe('overlap');
  });
});

describe('ra24: the reason names the first machine by name', () => {
  const offA = { name: 'a', overlap: false };
  const noUiB = { name: 'b', restartable: false };
  const reasonA = 'resharding beside the running shards is off on a (FLEET_RESHARD_OVERLAP=false)';

  it('machines read in name order give the first one\'s reason', async () => {
    const r = run({ page: 4, target: 6, row: { metaCount: 4 }, nodes: [offA, noUiB] });
    await r.driver.onPage(r.page);
    expect(r.warns).toEqual([l2Line(4, 6, reasonA, ['b'])]);
  });

  it('machines read in reverse name order still give the first one\'s reason', async () => {
    const r = run({ page: 4, target: 6, row: { metaCount: 4 }, nodes: [noUiB, offA] });
    await r.driver.onPage(r.page);
    expect(r.warns).toEqual([l2Line(4, 6, reasonA, ['b'])]);
  });

  it('two machines of one name keep the order they were read in', async () => {
    const r = run({
      page: 4, target: 6, row: { metaCount: 4 },
      nodes: [{ name: 'same', id: 'n1', restartable: false }, { name: 'same', id: 'n2', overlap: false }],
    });
    await r.driver.onPage(r.page);
    expect(r.warns).toEqual([l2Line(4, 6, 'same runs without the web UI', ['same'])]);
  });
});

describe('ra24: L18 for a recommendation that cannot reshard beside the shards', () => {
  it('names the setting to change on one machine, the fleet text', async () => {
    const r = run({ page: 4, target: null, recommendation: 6, row: { metaCount: 4 }, nodes: [{ name: 'a', restartable: false }] });
    await r.driver.onPage(r.page);
    expect(r.warns).toEqual([l18Line(6, 4, 'a runs without the web UI', false)]);
    expect(r.warns[0]).toContain('Set FLEET_SHARD_COUNT to 6 on one machine to reshard by stopping and starting every machine');
    expect(r.updates).toEqual([]);
    expect(r.driver.wait()).toEqual({ wanted: 6, source: 'discord', reason: 'a runs without the web UI', cannot: true });
  });
});

describe('ra24: the login budget', () => {
  it('starts when the budget holds exactly two logins per wanted shard', async () => {
    const r = run({ page: 4, target: 6, row: { metaCount: 4 }, nodes: [{ name: 'a' }], remaining: 12 });
    await r.driver.onPage(r.page);
    expect(r.warns).toEqual([]);
    expect(r.logs).toEqual([overlapLine(4, 6)]);
    expect(r.updates).toHaveLength(1);
    expect(r.driver.wait()).toBeNull();
  });

  it('waits with L19 when the budget holds fewer than two logins per wanted shard', async () => {
    const r = run({ page: 2, target: 4, row: { metaCount: 2 }, nodes: [{ name: 'a' }], remaining: 5 });
    await r.driver.onPage(r.page);
    expect(r.updates).toEqual([]);
    expect(r.logs).toEqual([]);
    expect(r.warns).toEqual([l19Line(4, 5, RESET_AT)]);
    expect(r.labels).toEqual(['the reshard check']);
    expect(r.driver.wait()).toEqual({
      wanted: 4, source: 'setting', reason: 'Discord allows 5 more gateway logins until 2026-11-11 12:00 UTC, and a reshard needs 8',
    });
  });

  it('logs L19 once while the same budget reason holds', async () => {
    const r = run({ page: 4, target: 6, row: { metaCount: 4 }, nodes: [{ name: 'a' }], remaining: 1 });
    await r.driver.onPage(r.page);
    expect(r.warns).toEqual([l19Line(6, 1, RESET_AT)]);
    await r.driver.onPage(r.page);
    expect(r.warns).toEqual([l19Line(6, 1, RESET_AT)]);
    expect(r.updates).toEqual([]);
  });
});

describe('ra24: the start transaction', () => {
  it('runs under the label the reshard start', async () => {
    const r = run({ page: 4, target: 6, row: { metaCount: 4 }, nodes: [{ name: 'a' }] });
    await r.driver.onPage(r.page);
    expect(r.labels).toEqual(['the reshard check', 'the reshard start']);
    expect(r.updates).toHaveLength(1);
  });

  it('a stored count other than the page read\'s starts nothing', async () => {
    const r = run({ page: 4, target: 6, row: { metaCount: 5 }, nodes: [{ name: 'a' }] });
    await r.driver.onPage(r.page);
    expect(r.labels).toEqual(['the reshard check']);
    expect(r.updates).toEqual([]);
    expect(r.logs).toEqual([]);
    expect(r.warns).toEqual([]);
  });

  it('an open attempt the page read did not show starts nothing and sets no wait', async () => {
    const r = run({
      page: 4, target: 6, row: { metaCount: 4, state: 'standby', attempt: ATTEMPT, fromCount: 4, toCount: 6 },
      nodes: [{ name: 'a' }], remaining: 1,
    });
    await r.driver.onPage(r.page);
    expect(r.labels).toEqual(['the reshard check']);
    expect(r.warns).toEqual([]);
    expect(r.logs).toEqual([]);
    expect(r.driver.wait()).toBeNull();
  });

  it('a closed attempt on the row does not hold the start', async () => {
    const r = run({ page: 4, target: 6, row: { metaCount: 4, state: 'done', attempt: ATTEMPT, fromCount: 2, toCount: 4 }, nodes: [{ name: 'a' }] });
    await r.driver.onPage(r.page);
    expect(r.logs).toEqual([overlapLine(4, 6)]);
    expect(r.updates).toHaveLength(1);
  });
});
