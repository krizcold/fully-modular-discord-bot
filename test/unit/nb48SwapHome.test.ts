import { describe, expect, it } from 'vitest';

import { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings, planReturns, returnRoom, type ClaimRow, type HandOver, type Me, type NodeRow } from '../../src/bot/internalSetup/fleet/claimRules';

// NB48: two machines at capacity, each holding the other's home shards. A return counts only the rows its home holds
// for itself, so each swapped shard goes home; a move still counts every row the receiver holds.

const T = claimTimings(30);
const UP = 1000;

interface Sent { text: string; values: unknown[] }

function fakePool(script: (text: string) => { rows: any[] }) {
  const sent: Sent[] = [];
  const pool = {
    async connect() {
      return {
        query(config: any, values?: unknown[]) {
          const text = typeof config === 'string' ? config : config.text;
          const bound = (typeof config === 'string' ? values : config.values) ?? [];
          sent.push({ text, values: bound });
          const answer = script(text);
          return Promise.resolve({ rows: answer.rows, rowCount: answer.rows.length });
        },
        release() { return undefined; },
      };
    },
    async end() { return undefined; },
    on() { return pool; },
  };
  return { pool, sent };
}

function storeWith(pool: object): ClaimStore {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = pool;
  return store;
}

const A: Me = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const K: Me = { processId: 'p-k', nodeId: 'n-k', nodeName: 'K' };
const D: Me = { processId: 'p-d', nodeId: 'n-d', nodeName: 'D' };

function dbClaim(shardId: number, holder: Me, home: string) {
  return {
    shard_count: 8, shard_id: shardId, claim: String(10 + shardId), holder_process: holder.processId, holder_node: holder.nodeId,
    holder_name: holder.nodeName, home_node: home, released: false, reserved: false, taken_at: 1, renewed_at: 2, ttl_ms: '30000',
    expires_up_ms: '50000', extended: false, renewed_ago_ms: 10,
  };
}

function dbNode(nodeId: string, extra: Record<string, unknown> = {}) {
  return {
    node_id: nodeId, node_name: nodeId.slice(2).toUpperCase(), process_id: `p-${nodeId.slice(2)}`, capacity: 2, takeover_seconds: 30,
    fit: true, restartable: true, returns: true, seen_ago_ms: 100, healthy_for_ms: 400_000, ...extra,
  };
}

const isRelease = (text: string) => /SET released = true, reserved = false/.test(text);

async function keptBy(claims: any[], nodes: any[], handOvers: HandOver[]): Promise<number[]> {
  const { pool, sent } = fakePool(text => {
    if (isRelease(text)) return { rows: [] };
    if (/^\s*SELECT up_ms::text/.test(text)) return { rows: [{ up_ms: String(UP), u_prime: String(UP), now_ms: 5000 }] };
    if (/FROM smdb_data\.shard_claims/.test(text)) return { rows: claims };
    if (/FROM smdb_data\.shard_nodes/.test(text)) return { rows: nodes };
    return { rows: [] };
  });
  await storeWith(pool).release({ me: A, reserved: [], handOvers, ttlMs: 30_000 });
  const call = sent.find(s => isRelease(s.text));
  if (!call) throw new Error('the release statement was not sent');
  return call.values[7] as number[];
}

const pair = (shardId: number) => ({ shardCount: 8, shardId, claim: 10 + shardId });
const ruleNode = (nodeId: string, over: Partial<NodeRow> = {}): NodeRow => ({
  nodeId, nodeName: nodeId.slice(2).toUpperCase(), processId: `p-${nodeId.slice(2)}`, capacity: 2, takeoverSeconds: 30,
  fit: true, restartable: true, returns: true, seenAgoMs: 100, healthyForMs: 400_000, ...over,
});
const ruleRow = (shardId: number, holder: Me, home: string): ClaimRow => ({
  shardCount: 8, shardId, claim: 10 + shardId, holderProcess: holder.processId, holderNode: holder.nodeId, holderName: holder.nodeName,
  homeNode: home, released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: UP + 30_000, extended: false,
});

describe('NB48: a return counts only the home\'s own rows', () => {
  const swapRows = [ruleRow(0, K, 'n-a'), ruleRow(1, K, 'n-a'), ruleRow(2, A, 'n-k'), ruleRow(3, A, 'n-k')];
  const swapClaims = [dbClaim(0, K, 'n-a'), dbClaim(1, K, 'n-a'), dbClaim(2, A, 'n-k'), dbClaim(3, A, 'n-k')];
  const twoNodes = [ruleNode('n-a'), ruleNode('n-k')];

  it('the live swap: A full with K\'s 2 and 3, K full with A\'s 0 and 1, each returns the other\'s shards home', () => {
    expect(planReturns({ me: A, capacity: 2, held: [pair(2), pair(3)], rows: swapRows, nodes: twoNodes, upMs: UP }))
      .toEqual([{ shardId: 2, receiver: 'n-k', move: false }, { shardId: 3, receiver: 'n-k', move: false }]);
    expect(planReturns({ me: K, capacity: 2, held: [pair(0), pair(1)], rows: swapRows, nodes: twoNodes, upMs: UP }))
      .toEqual([{ shardId: 0, receiver: 'n-a', move: false }, { shardId: 1, receiver: 'n-a', move: false }]);
  });

  it('the release keeps those returns under the lock', async () => {
    const kept = await keptBy(swapClaims, [dbNode('n-a'), dbNode('n-k')],
      [{ shardId: 2, receiver: 'n-k', move: false }, { shardId: 3, receiver: 'n-k', move: false }]);
    expect(kept).toEqual([2, 3]);
  });

  it('a home full with its own shards gets no return', async () => {
    const rows = [ruleRow(2, K, 'n-k'), ruleRow(3, K, 'n-k'), ruleRow(0, A, 'n-k'), ruleRow(1, A, 'n-a')];
    expect(returnRoom(ruleNode('n-k'), rows, UP)).toBe(0);
    expect(planReturns({ me: A, capacity: 2, held: [pair(0), pair(1)], rows, nodes: twoNodes, upMs: UP })).toEqual([]);
    const kept = await keptBy([dbClaim(2, K, 'n-k'), dbClaim(3, K, 'n-k'), dbClaim(0, A, 'n-k'), dbClaim(1, A, 'n-a')],
      [dbNode('n-a'), dbNode('n-k')], [{ shardId: 0, receiver: 'n-k', move: false }]);
    expect(kept).toEqual([]);
  });

  it('a move to a node full of foreign shards is still refused', async () => {
    const rows = [ruleRow(0, A, 'n-a'), ruleRow(1, A, 'n-a'), ruleRow(2, A, 'n-a'), ruleRow(3, D, 'n-k'), ruleRow(4, D, 'n-k')];
    const nodes = [ruleNode('n-a'), ruleNode('n-d'), ruleNode('n-k', { seenAgoMs: 600_000, healthyForMs: null })];
    expect(returnRoom(ruleNode('n-d'), rows, UP)).toBe(2);
    expect(planReturns({ me: A, capacity: 2, held: [pair(0), pair(1), pair(2)], rows, nodes, upMs: UP })).toEqual([]);
    const kept = await keptBy(
      [dbClaim(0, A, 'n-a'), dbClaim(1, A, 'n-a'), dbClaim(2, A, 'n-a'), dbClaim(3, D, 'n-k'), dbClaim(4, D, 'n-k')],
      [dbNode('n-a'), dbNode('n-d'), dbNode('n-k', { seen_ago_ms: 600_000, healthy_for_ms: null })],
      [{ shardId: 2, receiver: 'n-d', move: true }],
    );
    expect(kept).toEqual([]);
  });

  it('after the swap K holds all four: it returns 0 and 1 to A and moves nothing', () => {
    const rows = [ruleRow(0, K, 'n-a'), ruleRow(1, K, 'n-a'), ruleRow(2, K, 'n-k'), ruleRow(3, K, 'n-k')];
    expect(planReturns({ me: K, capacity: 2, held: [0, 1, 2, 3].map(pair), rows, nodes: twoNodes, upMs: UP }))
      .toEqual([{ shardId: 0, receiver: 'n-a', move: false }, { shardId: 1, receiver: 'n-a', move: false }]);
  });

  it('two returns to a home with return room 1: only the first is kept', async () => {
    const rows = [ruleRow(3, K, 'n-k'), ruleRow(0, K, 'n-a'), ruleRow(1, A, 'n-k'), ruleRow(2, A, 'n-k')];
    expect(returnRoom(ruleNode('n-k'), rows, UP)).toBe(1);
    expect(planReturns({ me: A, capacity: 2, held: [pair(1), pair(2)], rows, nodes: twoNodes, upMs: UP }))
      .toEqual([{ shardId: 1, receiver: 'n-k', move: false }]);
    const kept = await keptBy([dbClaim(3, K, 'n-k'), dbClaim(0, K, 'n-a'), dbClaim(1, A, 'n-k'), dbClaim(2, A, 'n-k')],
      [dbNode('n-a'), dbNode('n-k')], [{ shardId: 1, receiver: 'n-k', move: false }, { shardId: 2, receiver: 'n-k', move: false }]);
    expect(kept).toEqual([1]);
  });

  it('a return takes the place a move would count: no move follows it to the same node', async () => {
    const rows = [ruleRow(0, A, 'n-a'), ruleRow(1, A, 'n-a'), ruleRow(2, A, 'n-a'), ruleRow(3, A, 'n-k'), ruleRow(4, K, 'n-k')];
    expect(planReturns({ me: A, capacity: 2, held: [0, 1, 2, 3].map(pair), rows, nodes: twoNodes, upMs: UP }))
      .toEqual([{ shardId: 3, receiver: 'n-k', move: false }]);
    const kept = await keptBy(
      [dbClaim(0, A, 'n-a'), dbClaim(1, A, 'n-a'), dbClaim(2, A, 'n-a'), dbClaim(3, A, 'n-k'), dbClaim(4, K, 'n-k')],
      [dbNode('n-a'), dbNode('n-k')],
      [{ shardId: 3, receiver: 'n-k', move: false }, { shardId: 2, receiver: 'n-k', move: true }],
    );
    expect(kept).toEqual([3]);
  });
});
