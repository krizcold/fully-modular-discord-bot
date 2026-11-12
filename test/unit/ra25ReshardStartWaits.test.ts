import { describe, expect, it } from 'vitest';

import type { PageRead, WorkClient } from '../../src/bot/internalSetup/fleet/claimStore';
import type { GateRead } from '../../src/bot/internalSetup/fleet/reshardRules';
import { Reshard, l4bLine } from '../../src/bot/internalSetup/fleet/reshard';
import { retryTime } from '../../src/bot/internalSetup/fleet/shardClaims';

const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);
const DB_NOW = NOW - 7 * 60_000;
const UP = 100_000;

interface RowSpec { count: number; id: number; released?: boolean; expires?: number; name?: string }
interface NodeSpec { name: string; fit?: boolean; seenAgo?: number; takeover?: number }
interface FactSpec {
  state?: string | null; attempt?: string | null; meta?: number | null; retryAfter?: number | null;
  reason?: string | null; rows?: RowSpec[]; nodes?: NodeSpec[];
}

function fakeClient(f: FactSpec): WorkClient {
  return {
    async query(text: string) {
      if (text.includes('LEFT JOIN smdb_data.reshard')) {
        const state = f.state ?? null;
        return { rows: [{
          attempt: f.attempt ?? null, state, method: state === null ? null : 'overlap', from_count: state === null ? null : 2,
          to_count: state === null ? null : 4, target: 4, target_by: null, target_at: null, started_at: null, until_at: null,
          retry_after: f.retryAfter ?? null, failures: 0, reason: f.reason ?? null,
          meta_count: f.meta === undefined ? 2 : f.meta, up_ms: String(UP), now_ms: DB_NOW,
        }] };
      }
      if (text.includes('FROM smdb_data.shard_claims') && text.trim().startsWith('SELECT')) {
        return { rows: (f.rows ?? [{ count: 2, id: 0 }]).map(r => ({
          shard_count: r.count, shard_id: r.id, released: r.released ?? false, expires_up_ms: String(r.expires ?? UP + 30_000),
          ready: true, ttl_ms: '30000', renewed_ago_ms: 0, holder_process: 'p1', holder_node: 'n1', holder_name: r.name ?? 'alpha',
        })) };
      }
      if (text.includes('FROM smdb_data.shard_nodes')) {
        return { rows: (f.nodes ?? [{ name: 'alpha' }]).map((n, i) => ({
          node_id: `n${i + 1}`, node_name: n.name, process_id: `p${i + 1}`, fit: n.fit ?? true, restartable: true,
          reshard_overlap: true, takeover_seconds: n.takeover ?? 60, seen_ago_ms: n.seenAgo ?? 0, started_ago_ms: 3_600_000,
          memory_room: true, memory_free_mb: 4000, memory_use_mb: 200, memory_error: null, memory_ago_ms: 1000,
        })) };
      }
      return { rows: [] };
    },
  };
}

function rig(facts: FactSpec) {
  const h = { whats: [] as string[], logs: [] as string[], warns: [] as string[] };
  const reshard = new Reshard({
    claims: { processId: 'p1', ownCount: () => 2, stopServingForReshard: () => true, noteHandOver: () => undefined },
    withWorkClient: async (what, fn) => { h.whats.push(what); return fn(fakeClient(facts)); },
    me: { nodeId: 'n1', nodeName: 'alpha' },
    fitness: () => null,
    restartable: true,
    startLeave: () => undefined,
    send: () => undefined,
    intents: () => 1,
    maxConcurrency: () => 1,
    entry: () => 'claims',
    budget: () => ({ stale: false, remaining: 1000, resetAt: NOW + 3_600_000 }),
    recommendation: () => null,
    newAttempt: () => 'new-attempt',
    log: { log: l => { h.logs.push(String(l)); }, warn: l => { h.warns.push(String(l)); }, error: () => undefined },
    now: () => NOW,
  });
  return { h, reshard };
}

const idle: GateRead = { attempt: null, state: null, fromCount: null, toCount: null, metaCount: 2, target: 4 };
const page = (): PageRead => ({ shardCount: 2, upMs: UP, uPrimeMs: UP, rows: [], nodes: [], reshard: idle } as unknown as PageRead);

async function check(facts: FactSpec) {
  const r = rig(facts);
  await r.reshard.onPage(page());
  return r;
}

async function expectStarted(facts: FactSpec) {
  const { h, reshard } = await check(facts);
  expect(reshard.wait()).toBeNull();
  expect(h.whats).toEqual(['the reshard check', 'the reshard start']);
}

async function expectWait(facts: FactSpec, reason: string) {
  const { h, reshard } = await check(facts);
  expect(reshard.wait()).toEqual({ wanted: 4, source: 'setting', reason });
  expect(h.whats).toEqual(['the reshard check']);
}

describe('ra25 the start check leaves a changed read to the next page read', () => {
  it('starts nothing and shows no wait when the check finds an attempt the page read did not', async () => {
    const { h, reshard } = await check({ attempt: 'other', state: 'standby' });
    expect(reshard.wait()).toBeNull();
    expect(h.whats).toEqual(['the reshard check']);
  });

  it('starts nothing and shows no wait when the check finds another count in meta', async () => {
    const { h, reshard } = await check({ meta: 3 });
    expect(reshard.wait()).toBeNull();
    expect(h.whats).toEqual(['the reshard check']);
  });

  it('starts after a closed attempt the check finds', async () => {
    await expectStarted({ attempt: 'old', state: 'done' });
  });
});

describe('ra25 the start check waits for a call-off retry time', () => {
  it('waits with the recorded reason and the retry time on the bot clock', async () => {
    await expectWait({ retryAfter: DB_NOW + 20 * 60_000, reason: 'the flip timed out' },
      `the last try was called off (the flip timed out); the next try is after ${retryTime(NOW + 20 * 60_000)}`);
  });

  it('says no reason was recorded when the call-off holds none', async () => {
    await expectWait({ retryAfter: DB_NOW + 20 * 60_000, reason: null },
      `the last try was called off (no reason recorded); the next try is after ${retryTime(NOW + 20 * 60_000)}`);
  });

  it('starts once the retry time equals the database clock', async () => {
    await expectStarted({ retryAfter: DB_NOW });
  });

  it('starts once the retry time has passed', async () => {
    await expectStarted({ retryAfter: DB_NOW - 60_000 });
  });
});

describe('ra25 the start check waits for an unfit live machine', () => {
  it('names a live unfit machine seen a second ago', async () => {
    await expectWait({ nodes: [{ name: 'alpha' }, { name: 'beta', fit: false, seenAgo: 1000 }] }, 'beta is not healthy');
  });

  it('starts when the unfit machine was last seen exactly its takeover time ago', async () => {
    await expectStarted({ nodes: [{ name: 'alpha' }, { name: 'beta', fit: false, seenAgo: 60_000 }] });
  });

  it('starts when the unfit machine is long gone', async () => {
    await expectStarted({ nodes: [{ name: 'alpha' }, { name: 'beta', fit: false, seenAgo: 600_000 }] });
  });
});

describe('ra25 the start check waits for a live row of another count', () => {
  it('names the holder of a live row of another count', async () => {
    await expectWait({ rows: [{ count: 2, id: 0 }, { count: 3, id: 1, name: 'gamma' }] }, 'gamma still holds shards of another count');
  });

  it('starts when that row expires exactly at the stored clock', async () => {
    await expectStarted({ rows: [{ count: 2, id: 0 }, { count: 3, id: 1, name: 'gamma', expires: UP }] });
  });

  it('starts when that row has expired', async () => {
    await expectStarted({ rows: [{ count: 2, id: 0 }, { count: 3, id: 1, name: 'gamma', expires: UP - 5000 }] });
  });

  it('starts when that row was released', async () => {
    await expectStarted({ rows: [{ count: 2, id: 0 }, { count: 3, id: 1, name: 'gamma', released: true }] });
  });
});

describe('ra25 the web UI answers only an answer message', () => {
  const passing = { attempt: 'a', state: 'refused', kind: 'passing', reason: 'busy' };

  it('logs a passing refusal of an answer message', async () => {
    const { h, reshard } = rig({});
    await reshard.onMessage({ type: 'reshard:standby-state', data: passing });
    expect(h.warns).toEqual([l4bLine('busy')]);
  });

  it('ignores null and undefined', async () => {
    const { h, reshard } = rig({});
    await expect(reshard.onMessage(null)).resolves.toBeUndefined();
    await expect(reshard.onMessage(undefined)).resolves.toBeUndefined();
    expect(h.warns).toEqual([]);
    expect(h.whats).toEqual([]);
  });

  it('ignores a function that carries the answer fields', async () => {
    const { h, reshard } = rig({});
    const fn = Object.assign(() => undefined, { type: 'reshard:standby-state', data: passing });
    await reshard.onMessage(fn);
    expect(h.warns).toEqual([]);
  });

  it('ignores a message of another type that carries an answer', async () => {
    const { h, reshard } = rig({});
    await reshard.onMessage({ type: 'reshard:other', data: passing });
    expect(h.warns).toEqual([]);
    expect(h.whats).toEqual([]);
  });

  it('ignores an answer message with no attempt', async () => {
    const { h, reshard } = rig({});
    await reshard.onMessage({ type: 'reshard:standby-state', data: { state: 'refused', kind: 'passing', reason: 'busy' } });
    expect(h.warns).toEqual([]);
  });
});
