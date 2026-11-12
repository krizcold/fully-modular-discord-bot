import { describe, expect, it } from 'vitest';

import type { PageRead, PageRow, WorkClient } from '../../src/bot/internalSetup/fleet/claimStore';
import type { GateRead } from '../../src/bot/internalSetup/fleet/reshardRules';
import { JsonReshard, Reshard, l18Line, l26Reason, l3Line, l8Reason } from '../../src/bot/internalSetup/fleet/reshard';
import { l11Line, l7Line } from '../../src/bot/internalSetup/fleet/shardClaims';

const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);
const UP = 100_000;

interface RowSpec { count: number; id: number; process?: string; node?: string; name?: string; released?: boolean; expires?: number; ready?: boolean }
interface NodeSpec { id: string; name: string; process: string; fit?: boolean; restartable?: boolean; overlap?: boolean }
interface FactSpec {
  attempt: string | null; state: string | null; from: number | null; to: number | null; meta: number | null;
  startedAt?: number | null; untilAt?: number | null; retryAfter?: number | null; target?: number | null; reason?: string | null;
  rows?: RowSpec[]; nodes?: NodeSpec[];
}

function fakeClient(f: FactSpec, queries: string[]): WorkClient {
  return {
    async query(text: string) {
      queries.push(text);
      if (text.includes('LEFT JOIN smdb_data.reshard')) {
        return { rows: [{
          attempt: f.attempt, state: f.state, method: f.state === null ? null : 'overlap', from_count: f.from, to_count: f.to,
          target: f.target ?? null, target_by: null, target_at: null, started_at: f.startedAt ?? NOW - 60_000,
          until_at: f.untilAt ?? NOW + 600_000, retry_after: f.retryAfter ?? null, failures: 0, reason: f.reason ?? null,
          meta_count: f.meta, up_ms: String(UP), now_ms: NOW,
        }] };
      }
      if (text.includes('FROM smdb_data.shard_claims') && text.trim().startsWith('SELECT')) {
        return { rows: (f.rows ?? []).map(r => ({
          shard_count: r.count, shard_id: r.id, released: r.released ?? false, expires_up_ms: String(r.expires ?? UP + 30_000),
          ready: r.ready ?? true, ttl_ms: '30000', renewed_ago_ms: 0, holder_process: r.process ?? 'p1',
          holder_node: r.node ?? 'n1', holder_name: r.name ?? 'alpha',
        })) };
      }
      if (text.includes('FROM smdb_data.shard_nodes')) {
        return { rows: (f.nodes ?? []).map(n => ({
          node_id: n.id, node_name: n.name, process_id: n.process, fit: n.fit ?? true, restartable: n.restartable ?? true,
          reshard_overlap: n.overlap ?? true, takeover_seconds: 60, seen_ago_ms: 0, started_ago_ms: 3_600_000,
          memory_room: true, memory_free_mb: 4000, memory_use_mb: 200, memory_error: null, memory_ago_ms: 1000,
        })) };
      }
      if (text.includes('RETURNING') && text.includes('retry_after')) return { rows: [{ retry_after: NOW + 900_000 }] };
      return { rows: [] };
    },
  };
}

interface RigOptions {
  facts?: FactSpec;
  own?: number | null;
  fitness?: string | null;
  restartable?: boolean;
  send?: boolean;
}

function rig(o: RigOptions = {}) {
  const h = {
    whats: [] as string[], queries: [] as string[], sent: [] as any[], logs: [] as string[], warns: [] as string[],
    leaves: [] as { reason: string; handOver?: { attempt: string | null } }[], stops: 0, notes: [] as [number, number][],
  };
  const own = o.own === undefined ? 2 : o.own;
  const facts = o.facts ?? { attempt: null, state: null, from: null, to: null, meta: 2 };
  const reshard = new Reshard({
    claims: {
      processId: 'p1',
      ownCount: () => own,
      stopServingForReshard: () => { h.stops += 1; return true; },
      noteHandOver: (from, to) => { h.notes.push([from, to]); },
    },
    withWorkClient: async (what, fn) => { h.whats.push(what); return fn(fakeClient(facts, h.queries)); },
    me: { nodeId: 'n1', nodeName: 'alpha' },
    fitness: () => (o.fitness === undefined ? null : o.fitness),
    restartable: o.restartable ?? true,
    startLeave: (reason, handOver) => { h.leaves.push({ reason, handOver }); },
    send: o.send === false ? null : (m => { h.sent.push(m); }),
    intents: () => 1,
    maxConcurrency: () => 1,
    entry: () => 'claims',
    budget: () => null,
    recommendation: () => null,
    newAttempt: () => 'new-attempt',
    log: { log: l => { h.logs.push(String(l)); }, warn: l => { h.warns.push(String(l)); }, error: () => undefined },
    now: () => NOW,
  });
  return { h, reshard };
}

function pageRow(r: { count: number; process: string; released?: boolean; expires: number }): PageRow {
  return {
    shardCount: r.count, shardId: 0, claim: 1, holderProcess: r.process, holderNode: 'n1', holderName: 'alpha', homeNode: 'n1',
    released: r.released ?? false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: r.expires,
    extended: false, renewedAgoMs: 0,
  } as unknown as PageRow;
}

function page(shardCount: number | null, reshard: GateRead | undefined, rows: PageRow[] = []): PageRead {
  return { shardCount, upMs: UP, uPrimeMs: UP, rows, nodes: [], reshard };
}

const gate = (g: Partial<GateRead>): GateRead => ({ attempt: null, state: null, fromCount: null, toCount: null, metaCount: null, ...g });

const flippedTo4 = gate({ attempt: 'a', state: 'flipped', fromCount: 2, toCount: 4, metaCount: 4 });

describe('ra23 hand-over at a page read (decisions 9 and 25)', () => {
  it('hands over when the only live row this process holds is of its old count', async () => {
    const { h, reshard } = rig({ own: 2 });
    await reshard.onPage(page(4, flippedTo4, [pageRow({ count: 2, process: 'p1', expires: UP + 30_000 })]));
    expect(reshard.handedOver()).toBe(true);
    expect(h.leaves).toEqual([{ reason: l8Reason(4), handOver: { attempt: 'a' } }]);
    expect(h.notes).toEqual([[2, 4]]);
  });

  it('hands over when its row of the new count has expired', async () => {
    const { h, reshard } = rig({ own: 2 });
    await reshard.onPage(page(4, flippedTo4, [pageRow({ count: 4, process: 'p1', expires: UP - 1 })]));
    expect(reshard.handedOver()).toBe(true);
    expect(h.leaves).toEqual([{ reason: l8Reason(4), handOver: { attempt: 'a' } }]);
  });

  it('hands over when its row of the new count expires exactly at the stored clock', async () => {
    const { h, reshard } = rig({ own: 2 });
    await reshard.onPage(page(4, flippedTo4, [pageRow({ count: 4, process: 'p1', expires: UP })]));
    expect(reshard.handedOver()).toBe(true);
    expect(h.leaves).toEqual([{ reason: l8Reason(4), handOver: { attempt: 'a' } }]);
  });

  it('keeps serving while it holds a live row of the new count', async () => {
    const { h, reshard } = rig({ own: 2 });
    await reshard.onPage(page(4, flippedTo4, [pageRow({ count: 4, process: 'p1', expires: UP + 1 })]));
    expect(reshard.handedOver()).toBe(false);
    expect(h.leaves).toEqual([]);
  });
});

describe('ra23 stop-start leave at a page read (decision 12)', () => {
  it('leaves for a stopping attempt from its own count and stays ended', async () => {
    const { h, reshard } = rig({ own: 2 });
    const stopping = gate({ attempt: 'a', state: 'stopping', fromCount: 2, toCount: 4, metaCount: 2 });
    await reshard.onPage(page(2, stopping));
    expect(reshard.handedOver()).toBe(true);
    expect(h.leaves).toEqual([{ reason: l26Reason(4), handOver: undefined }]);
    expect(h.stops).toBe(1);
  });

  it('does not leave for a stopping row that holds no attempt', async () => {
    const { h, reshard } = rig({ own: 2 });
    await reshard.onPage(page(2, gate({ attempt: null, state: 'stopping', fromCount: 2, toCount: 4, metaCount: 2 })));
    expect(reshard.handedOver()).toBe(false);
    expect(h.leaves).toEqual([]);
    expect(h.stops).toBe(0);
  });

  it('does not leave for a stopping attempt from another count', async () => {
    const { h, reshard } = rig({ own: 2 });
    await reshard.onPage(page(2, gate({ attempt: 'a', state: 'stopping', fromCount: 3, toCount: 4, metaCount: 2 })));
    expect(reshard.handedOver()).toBe(false);
    expect(h.leaves).toEqual([]);
    expect(h.stops).toBe(0);
  });
});

describe('ra23 the start check by state', () => {
  it('judges a start after a closed attempt, and waits on its own health', async () => {
    const { h, reshard } = rig({ own: 2, fitness: 'maintenance' });
    await reshard.onPage(page(2, gate({ attempt: 'old', state: 'done', fromCount: 1, toCount: 2, metaCount: 2, target: 4 })));
    expect(reshard.wait()).toEqual({ wanted: 4, source: 'setting', reason: 'alpha is not healthy' });
    expect(h.whats).toEqual([]);
  });

  it('judges no start while an attempt is flipped', async () => {
    const { h, reshard } = rig({ own: 2, fitness: 'maintenance' });
    await reshard.onPage(page(2, gate({ attempt: 'a', state: 'flipped', fromCount: 2, toCount: 4, metaCount: 2, target: 4 })));
    expect(reshard.wait()).toBeNull();
    expect(h.whats).toEqual([]);
  });
});

const standbyA = gate({ attempt: 'a', state: 'standby', fromCount: 2, toCount: 4, metaCount: 2 });
const oldRows: RowSpec[] = [{ count: 2, id: 0 }, { count: 2, id: 1 }];
const nodes: NodeSpec[] = [{ id: 'n1', name: 'alpha', process: 'p1' }];
const waiting = (over: Partial<FactSpec> = {}): FactSpec => ({
  attempt: 'a', state: 'standby', from: 2, to: 4, meta: 2, rows: oldRows, nodes, ...over,
});

describe('ra23 during a standby attempt (decisions 8, 11 and the ask)', () => {
  it('asks the web UI for the second process under the reshard check', async () => {
    const { h, reshard } = rig({ facts: waiting() });
    await reshard.onPage(page(2, standbyA));
    expect(h.whats).toEqual(['the reshard check']);
    expect(h.sent).toEqual([{ type: 'control:reshard-standby', data: { attempt: 'a', to: 4, intents: 1, maxConcurrency: 1, entry: 'claims' } }]);
    expect(h.logs).toEqual([l3Line()]);
  });

  it('does nothing when the row now holds another standby attempt', async () => {
    const { h, reshard } = rig({ facts: waiting({ attempt: 'b' }) });
    await reshard.onPage(page(2, standbyA));
    expect(h.sent).toEqual([]);
    expect(h.logs).toEqual([]);
    expect(h.whats).toEqual(['the reshard check']);
  });

  it('does nothing when the attempt is no longer standby', async () => {
    const { h, reshard } = rig({ facts: waiting({ state: 'cancelled' }) });
    await reshard.onPage(page(2, standbyA));
    expect(h.sent).toEqual([]);
    expect(h.logs).toEqual([]);
    expect(h.whats).toEqual(['the reshard check']);
  });

  it('flips once every new shard is connected, logs L7 and asks nothing', async () => {
    const rows: RowSpec[] = [...oldRows, ...[0, 1, 2, 3].map(id => ({ count: 4, id, process: 'p2' }))];
    const { h, reshard } = rig({ facts: waiting({ rows }) });
    await reshard.onPage(page(2, standbyA));
    expect(h.whats).toEqual(['the reshard check', 'the flip']);
    expect(h.queries.some(q => q.includes('UPDATE smdb_data.meta SET value'))).toBe(true);
    expect(h.logs).toEqual([l7Line(4, 2)]);
    expect(h.sent).toEqual([]);
  });

  it('calls off an attempt past its time, logs L11 and asks nothing', async () => {
    const { h, reshard } = rig({ facts: waiting({ startedAt: NOW - 600_000, untilAt: NOW - 1 }) });
    await reshard.onPage(page(2, standbyA));
    expect(h.whats).toEqual(['the reshard check', 'the call-off']);
    expect(h.warns).toEqual([l11Line(4, 'not all 4 new shards were connected within 10 min (0 were)', 2, NOW + 900_000)]);
    expect(h.sent).toEqual([]);
  });

  it('asks nothing while this process is unfit', async () => {
    const { h, reshard } = rig({ facts: waiting(), fitness: 'maintenance', restartable: true });
    await reshard.onPage(page(2, standbyA));
    expect(h.sent).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('asks nothing with no web UI process to fork the standby', async () => {
    const { h, reshard } = rig({ facts: waiting(), restartable: false });
    await reshard.onPage(page(2, standbyA));
    expect(h.sent).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});

const closed = (over: Partial<GateRead> = {}) => gate({ attempt: 'old', state: 'done', fromCount: 1, toCount: 2, metaCount: 2, ...over });

describe('ra23 the start judgement (decision 6)', () => {
  it('waits for nothing while this process has no count yet', async () => {
    const { h, reshard } = rig({ own: null, fitness: 'maintenance' });
    await reshard.onPage(page(2, closed({ target: 4 })));
    expect(reshard.wait()).toBeNull();
    expect(h.whats).toEqual([]);
  });

  it('waits for nothing when the wanted count is the running one', async () => {
    const { h, reshard } = rig({ fitness: 'maintenance' });
    await reshard.onPage(page(2, closed({ target: 2 })));
    expect(reshard.wait()).toBeNull();
    expect(h.whats).toEqual([]);
  });

  it('names the setting as the source and its own health as the reason, with no database read', async () => {
    const { h, reshard } = rig({ fitness: 'maintenance' });
    await reshard.onPage(page(2, closed({ target: 4 })));
    expect(reshard.wait()).toEqual({ wanted: 4, source: 'setting', reason: 'alpha is not healthy' });
    expect(h.whats).toEqual([]);
  });

  it('leaves the wait unset when the check reads another count than the page did', async () => {
    const { h, reshard } = rig({ facts: { attempt: 'old', state: 'done', from: 1, to: 2, meta: 3, rows: [], nodes } });
    await reshard.onPage(page(2, closed({ target: 4 })));
    expect(h.whats).toEqual(['the reshard check']);
    expect(reshard.wait()).toBeNull();
  });

  it('waits with the reason the check found: another machine is unfit', async () => {
    const facts: FactSpec = {
      attempt: 'old', state: 'done', from: 1, to: 2, meta: 2, rows: [{ count: 2, id: 0 }],
      nodes: [...nodes, { id: 'n2', name: 'beta', process: 'p9', fit: false }],
    };
    const { h, reshard } = rig({ facts });
    await reshard.onPage(page(2, closed({ target: 4 })));
    expect(h.whats).toEqual(['the reshard check']);
    expect(reshard.wait()).toEqual({ wanted: 4, source: 'setting', reason: 'beta is not healthy' });
  });
});

describe('ra23 L18 repeat (decision 15)', () => {
  it('logs L18 once for one reason within the hour, and again after it', () => {
    let now = NOW;
    const warns: string[] = [];
    const json = new JsonReshard({
      nodeName: 'A', countSetting: () => null, recommendation: () => 4, runningCount: () => 2, fitness: () => null,
      overlap: () => true, memory: () => null, startedAgoMs: () => 3_600_000, budget: () => null, send: null,
      intents: () => 1, maxConcurrency: () => 1, handOver: () => undefined,
      log: { log: () => undefined, warn: l => { warns.push(String(l)); }, error: () => undefined },
      now: () => now,
    });
    const line = l18Line(4, 2, 'A runs without the web UI', true);
    json.tick();
    now += 1000;
    json.tick();
    expect(warns).toEqual([line]);
    now = NOW + 60 * 60_000;
    json.tick();
    expect(warns).toEqual([line, line]);
  });
});
